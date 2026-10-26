import { prisma } from "./db";
import { logAudit } from "./audit";
import type { Prisma, Subscription, CreditBucket, CreditMovementKind } from "@prisma/client";

/**
 * Motor de créditos.
 *
 * A unidade comercial do sistema é o CRÉDITO, não a análise: cada chamada de IA
 * custa dinheiro para a Leão Amorim, então processos maiores consomem mais de um
 * crédito (ver `custoEmCreditos`).
 *
 * Duas bolsas, com regras de expiração diferentes:
 *  - MENSAL    — liberada a cada ciclo; o que sobra NÃO acumula, expira no fim.
 *  - ADICIONAL — pacotes avulsos comprados; validade própria (padrão 90 dias).
 * O consumo tira primeiro da mensal, para que o crédito que vai expirar antes
 * seja o primeiro a ser usado.
 *
 * INVARIANTE CENTRAL: todo movimento passa por `movimentar`, que grava uma linha
 * em CreditLedger com saldo anterior e posterior dentro da MESMA transação que
 * altera o saldo. Contador e extrato nunca divergem; se divergirem, o extrato
 * manda.
 */

// ---------------------------------------------------------------------------
// Custo de uma análise
// ---------------------------------------------------------------------------

/** Faixas de tamanho do processo e o que cada uma custa. */
export const FAIXAS_CUSTO = [
  { atePaginas: 250, creditos: 1, maxMb: 30 },
  { atePaginas: 500, creditos: 2, maxMb: 60 },
  { atePaginas: 1000, creditos: 4, maxMb: 120 },
] as const;

/** Acima disto o processamento automático é recusado (análise especial). */
export const MAX_PAGINAS_AUTOMATICO = 1000;

export interface CustoAnalise {
  creditos: number;
  paginas: number;
  bytes: number;
  /** Quando true, o processamento automático não é permitido. */
  bloqueado: boolean;
  motivo?: string;
  faixa?: string;
}

/**
 * Quanto custa analisar um processo, pelo número de páginas e pelo tamanho.
 *
 * O limite de MB acompanha a faixa de páginas em vez de ser fixo em 30 MB: um
 * processo de 800 páginas digitalizadas passa de 30 MB com facilidade e recusá-lo
 * por tamanho, depois de já ter aceitado a faixa de páginas, seria incoerente.
 */
export function custoEmCreditos(paginas: number, bytes: number): CustoAnalise {
  const pgs = Math.max(0, Math.trunc(paginas));
  const mb = bytes / (1024 * 1024);

  if (pgs > MAX_PAGINAS_AUTOMATICO) {
    return {
      creditos: 0,
      paginas: pgs,
      bytes,
      bloqueado: true,
      motivo:
        `Este processo tem ${pgs} páginas e ultrapassa o limite de ${MAX_PAGINAS_AUTOMATICO} ` +
        `páginas do processamento automático. Solicite uma análise especial ao nosso atendimento.`,
    };
  }

  const faixa = FAIXAS_CUSTO.find((f) => pgs <= f.atePaginas) ?? FAIXAS_CUSTO[FAIXAS_CUSTO.length - 1]!;
  if (mb > faixa.maxMb) {
    return {
      creditos: faixa.creditos,
      paginas: pgs,
      bytes,
      bloqueado: true,
      motivo:
        `O arquivo tem ${mb.toFixed(1)} MB e ultrapassa o limite de ${faixa.maxMb} MB para processos ` +
        `de até ${faixa.atePaginas} páginas. Envie o PDF sem anexos de mídia ou divida o processo em partes.`,
    };
  }

  return {
    creditos: faixa.creditos,
    paginas: pgs,
    bytes,
    bloqueado: false,
    faixa: `até ${faixa.atePaginas} páginas`,
  };
}

// ---------------------------------------------------------------------------
// Saldo
// ---------------------------------------------------------------------------

export interface SaldoCreditos {
  /** Legado: plano com cota 0 significa sem limite. Nenhum plano comercial usa. */
  ilimitado: boolean;
  cotaMensal: number;
  usadosNoCiclo: number;
  saldoMensal: number;
  saldoAdicional: number;
  total: number;
}

export function saldoDe(sub: Subscription | null): SaldoCreditos {
  if (!sub) {
    return { ilimitado: false, cotaMensal: 0, usadosNoCiclo: 0, saldoMensal: 0, saldoAdicional: 0, total: 0 };
  }
  const ilimitado = sub.analysesQuota === 0;
  const saldoMensal = Math.max(0, sub.analysesQuota - sub.analysesUsed);
  const saldoAdicional = Math.max(0, sub.extraAnalyses);
  return {
    ilimitado,
    cotaMensal: sub.analysesQuota,
    usadosNoCiclo: sub.analysesUsed,
    saldoMensal,
    saldoAdicional,
    total: ilimitado ? Number.POSITIVE_INFINITY : saldoMensal + saldoAdicional,
  };
}

/** Há saldo para uma análise que custa `creditos`? */
export function temSaldo(sub: Subscription | null, creditos: number): boolean {
  const s = saldoDe(sub);
  return s.ilimitado || s.total >= creditos;
}

/** Mensagem única de saldo insuficiente (exigida na especificação). */
export const MSG_SEM_SALDO =
  "Você utilizou todas as análises disponíveis no seu plano. Compre créditos adicionais, " +
  "faça upgrade ou aguarde a próxima renovação para continuar.";

export class SaldoInsuficienteError extends Error {
  readonly necessarios: number;
  readonly disponiveis: number;
  constructor(necessarios: number, disponiveis: number) {
    super(MSG_SEM_SALDO);
    this.name = "SaldoInsuficienteError";
    this.necessarios = necessarios;
    this.disponiveis = disponiveis;
  }
}

/** Falha de concorrência: outra requisição mexeu no saldo durante a transação. */
export class ConcorrenciaCreditoError extends Error {
  constructor() {
    super("O saldo foi alterado por outra operação. Tente novamente.");
    this.name = "ConcorrenciaCreditoError";
  }
}

// ---------------------------------------------------------------------------
// Movimentação (núcleo)
// ---------------------------------------------------------------------------

interface MovimentoEntrada {
  subscriptionId: string;
  kind: CreditMovementKind;
  bucket: CreditBucket | null;
  /** Positivo = entrada; negativo = saída. */
  quantity: number;
  description: string;
  analysisId?: string | null;
  paymentId?: string | null;
  actorId?: string | null;
  reason?: string | null;
  expiresAt?: Date | null;
  idempotencyKey?: string | null;
}

/**
 * Grava uma linha da razão dentro de uma transação já aberta, calculando o saldo
 * anterior e o posterior. Não altera o contador: quem chama já o alterou, e é o
 * saldo resultante que chega aqui em `saldoDepois`.
 */
async function registrarNaRazao(
  tx: Prisma.TransactionClient,
  mov: MovimentoEntrada,
  saldoAntes: number,
  saldoDepois: number,
) {
  return tx.creditLedger.create({
    data: {
      subscriptionId: mov.subscriptionId,
      kind: mov.kind,
      bucket: mov.bucket,
      quantity: mov.quantity,
      balanceBefore: saldoAntes,
      balanceAfter: saldoDepois,
      description: mov.description,
      analysisId: mov.analysisId ?? null,
      paymentId: mov.paymentId ?? null,
      actorId: mov.actorId ?? null,
      reason: mov.reason ?? null,
      expiresAt: mov.expiresAt ?? null,
      idempotencyKey: mov.idempotencyKey ?? null,
    },
  });
}

/** Saldo total (mensal + adicional) de um snapshot de assinatura. */
function totalDe(sub: Pick<Subscription, "analysesQuota" | "analysesUsed" | "extraAnalyses">): number {
  return Math.max(0, sub.analysesQuota - sub.analysesUsed) + Math.max(0, sub.extraAnalyses);
}

// ---------------------------------------------------------------------------
// Consumo
// ---------------------------------------------------------------------------

export interface ResultadoConsumo {
  consumidos: number;
  daMensal: number;
  doAdicional: number;
  saldoRestante: number;
  jaConsumido: boolean;
  /**
   * A análise já estava paga e CRESCEU de faixa: aqui só a diferença foi debitada.
   * Ver a seção "reprocessamento que muda de faixa" em `consumirCreditos`.
   */
  complementoCobrado?: number;
}

/**
 * Quanto esta análise já pagou, e ainda não teve devolvido.
 *
 * A razão é a fonte da verdade — `Analysis.creditsCharged` é campo denormalizado, e
 * quando os dois divergem manda o extrato. Existe como função própria porque a
 * pergunta é feita em dois lugares: no orçamento, que decide o que o cliente lê antes
 * de confirmar, e no consumo, que decide o débito. Os dois responderem de formas
 * diferentes é como nasce cobrança que a tela não anunciou.
 */
export async function jaCobradoNaAnalise(subscriptionId: string, analysisId: string): Promise<number> {
  const historico = await prisma.creditLedger.findMany({
    where: { subscriptionId, analysisId, kind: { in: ["CONSUMO", "ESTORNO"] } },
    select: { kind: true, quantity: true },
  });
  const cobrado = historico.filter((l) => l.kind === "CONSUMO").reduce((s, l) => s - l.quantity, 0);
  const devolvido = historico.filter((l) => l.kind === "ESTORNO").reduce((s, l) => s + l.quantity, 0);
  return Math.max(0, cobrado - devolvido);
}

/**
 * A assinatura que REALMENTE cobrou esta análise.
 *
 * ── O furo de dinheiro que isto conserta ──────────────────────────────────────
 * O estorno automático da falha resolvia a assinatura por `getActiveSubscription(org)` — a
 * assinatura ATIVA AGORA. Não é a mesma coisa que a assinatura que cobrou, e a diferença custa
 * crédito do cliente:
 *
 *  - Análise longa cujo processamento atravessa a virada do ciclo, ou o cliente cancela, ou o
 *    admin suspende, ou o estorno de uma cobrança põe a conta em ESTORNADA — em qualquer desses,
 *    `getActiveSubscription` devolve NULO no momento da falha, o estorno nem é tentado, e o
 *    cliente fica sem o crédito que pagou por uma análise que não recebeu.
 *  - E se a organização tiver outra assinatura corrente, passar a errada faria `estornarCreditos`
 *    não encontrar consumo e devolver zero — silenciosamente, com aparência de sucesso.
 *
 * O vínculo verdadeiro está na RAZÃO: a linha de CONSUMO guarda contra qual assinatura o crédito
 * saiu. É ela que manda, e é ela que sobrevive a qualquer mudança de estado da assinatura.
 */
export async function assinaturaQueCobrou(analysisId: string): Promise<string | null> {
  const consumo = await prisma.creditLedger.findFirst({
    where: { analysisId, kind: "CONSUMO" },
    orderBy: { createdAt: "asc" },
    select: { subscriptionId: true },
  });
  return consumo?.subscriptionId ?? null;
}

/**
 * Devolve os créditos de uma análise, achando sozinho a assinatura que cobrou.
 *
 * É o ponto de entrada que o processamento e a ferramenta administrativa usam: assim os dois
 * respondem igual, e nenhum deles precisa saber que a assinatura vem da razão.
 *
 * Devolve `semCobranca` quando não houve cobrança nenhuma — diferente de "estornei zero", que
 * significaria já devolvido. A distinção existe porque quem chama precisa saber se há algo a
 * fazer: nada a estornar não é problema, estorno que falhou é.
 */
export async function estornarCreditosDaAnalise(
  analysisId: string,
  motivo: string,
): Promise<{ estornados: number; jaEstornado: boolean; semCobranca: boolean }> {
  const subscriptionId = await assinaturaQueCobrou(analysisId);
  if (!subscriptionId) return { estornados: 0, jaEstornado: false, semCobranca: true };
  const r = await estornarCreditos(subscriptionId, analysisId, motivo);
  return { ...r, semCobranca: false };
}

/**
 * Debita créditos por uma análise. Idempotente por análise: chamar duas vezes
 * para a mesma análise não cobra duas vezes — é o que protege contra reenvio de
 * requisição e clique duplo.
 *
 * Tira primeiro da bolsa mensal (que expira antes) e só depois da adicional.
 * Cada bolsa vira uma linha própria na razão, para que o estorno saiba devolver
 * cada crédito à bolsa de onde saiu.
 */
export async function consumirCreditos(
  subscriptionId: string,
  analysisId: string,
  creditos: number,
  descricao = "Análise jurídica",
): Promise<ResultadoConsumo> {
  if (creditos <= 0) throw new Error("Consumo precisa ser de pelo menos 1 crédito.");

  return prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });

    /**
     * Idempotência do consumo, contando o ESTORNO.
     *
     * A regra era "existe CONSUMO desta análise? então já foi cobrada" — e ela ignorava
     * que o estorno pode ter devolvido o crédito. `estornarCreditos` acrescenta uma
     * linha de ESTORNO e DEIXA a linha de CONSUMO no lugar, porque o extrato precisa
     * mostrar as duas. O efeito: análise que falha é estornada, o cliente roda de novo
     * e a cobrança é ignorada — a análise passa a sair de graça, para sempre, e o
     * estorno por erro técnico virou um jeito de não pagar.
     *
     * A pergunta certa é se existe consumo NÃO ESTORNADO: quantas vezes esta análise
     * foi cobrada, menos quantas foram devolvidas. Zero significa que ela está em
     * aberto e deve ser cobrada de novo.
     */
    const historico = await tx.creditLedger.findMany({
      where: { subscriptionId, analysisId, kind: { in: ["CONSUMO", "ESTORNO"] } },
    });
    const cobrancas = historico.filter((l) => l.kind === "CONSUMO");
    const estornos = historico.filter((l) => l.kind === "ESTORNO");
    /**
     * A TENTATIVA é o que dá identidade própria a cada cobrança da mesma análise.
     * Sem ela, a segunda cobrança colidiria com a chave da primeira
     * (`consumo:<analise>:mensal`) e o débito viraria um no-op silencioso: o cliente
     * receberia a análise sem pagar, agora pelo outro caminho.
     */
    const tentativa = estornos.filter((l) => l.bucket === "MENSAL" || l.bucket === "ADICIONAL").length;
    const emAberto = cobrancas.length > estornos.length;

    /**
     * ── REPROCESSAMENTO QUE MUDA DE FAIXA ────────────────────────────────────────
     *
     * "Análise já cobrada não cobra de novo" é regra do produto, e é justa: reprocessar
     * depois de uma correção técnica não deve custar duas vezes. Mas ela era aplicada
     * sem olhar O QUE está sendo reprocessado.
     *
     * O caminho: o cliente envia 200 páginas (1 crédito), processa, e depois ACRESCENTA
     * 700 páginas e manda reprocessar. O processo agora custa 4 créditos pela tabela de
     * faixas — e saía por 1, porque já havia sido cobrado. Nem a trava de saldo pegava:
     * a rota de processar pulava a conferência inteira quando a análise já tinha
     * cobrança. Dava para analisar mil páginas por um crédito, quantas vezes quisesse,
     * até com saldo zero.
     *
     * A regra correta preserva as duas promessas: reprocessar o MESMO material é
     * gratuito, e material que cresceu de faixa paga a DIFERENÇA. O cliente nunca paga
     * duas vezes pelo que já pagou.
     */
    /**
     * ⚠️ "JÁ COBRADO" É LÍQUIDO: cobranças MENOS devoluções.
     *
     * Era bruto — somava todas as linhas de CONSUMO e ignorava os ESTORNOS. Duas consequências, e a
     * segunda é dinheiro:
     *
     *  1. Discordava da tela. `jaCobradoNaAnalise`, que alimenta o orçamento mostrado ao cliente, sempre
     *     calculou líquido (`cobrado - devolvido`). O cliente lia "esta análise já consumiu 1 crédito" e
     *     a cobrança acreditava que eram 4.
     *  2. Depois de uma devolução parcial, a análise virava de graça. Cobrado 1, entregue; documentos
     *     acrescentados, complemento de 3; essa execução falha e devolve 3. Com o bruto, `jaCobrado`
     *     continuava 4 e o complemento de uma nova tentativa saía zero — o cliente pagava 1 por uma
     *     análise de 4 créditos, para sempre.
     *
     * O líquido preserva a promessa que importa: reprocessar o MESMO material continua gratuito, porque
     * sem devolução no meio o líquido é igual ao bruto.
     */
    const liquidoPorBolsa = (bolsa: "MENSAL" | "ADICIONAL") => {
      const cobrado = cobrancas.filter((l) => l.bucket === bolsa).reduce((s, l) => s - l.quantity, 0);
      const devolvido = estornos.filter((l) => l.bucket === bolsa).reduce((s, l) => s + l.quantity, 0);
      return Math.max(0, cobrado - devolvido);
    };
    const cobradoMensal = liquidoPorBolsa("MENSAL");
    const cobradoAdicional = liquidoPorBolsa("ADICIONAL");
    const jaCobrado = cobradoMensal + cobradoAdicional;
    const complemento = emAberto ? Math.max(0, creditos - jaCobrado) : 0;

    /**
     * Nada a complementar — ou plano legado SEM LIMITE, onde o consumo é registrado com
     * quantidade zero e não existe diferença a cobrar.
     */
    if (emAberto && (complemento === 0 || sub.analysesQuota === 0)) {
      return {
        consumidos: jaCobrado,
        daMensal: cobradoMensal,
        doAdicional: cobradoAdicional,
        saldoRestante: totalDe(sub),
        jaConsumido: true,
      };
    }

    /** Quanto sai do saldo AGORA: tudo na primeira cobrança, só a diferença depois. */
    const aDebitar = emAberto ? complemento : creditos;

    /**
     * Sufixo de chave. Vazio na primeira cobrança, para não mexer no histórico.
     * `:t{n}` distingue a recobrança depois de um estorno. `:c{total}` distingue o
     * complemento de faixa e o torna idempotente pelo total já atingido: reprocessar de
     * novo na MESMA faixa não cobra outra vez.
     */
    const sufixo = `${tentativa > 0 ? `:t${tentativa}` : ""}${emAberto ? `:c${creditos}` : ""}`;

    // Cota 0 = ilimitado (legado). Registra o uso para o extrato, sem debitar.
    if (sub.analysesQuota === 0) {
      const saldo = totalDe(sub);
      await registrarNaRazao(
        tx,
        {
          subscriptionId,
          kind: "CONSUMO",
          bucket: null,
          quantity: 0,
          description: `${descricao} (plano sem limite de créditos)`,
          analysisId,
          idempotencyKey: `consumo:${analysisId}:ilimitado${sufixo}`,
        },
        saldo,
        saldo,
      );
      return { consumidos: 0, daMensal: 0, doAdicional: 0, saldoRestante: saldo, jaConsumido: false };
    }

    const saldoMensal = Math.max(0, sub.analysesQuota - sub.analysesUsed);
    const saldoAdicional = Math.max(0, sub.extraAnalyses);
    const disponivel = saldoMensal + saldoAdicional;
    if (disponivel < aDebitar) throw new SaldoInsuficienteError(aDebitar, disponivel);

    const daMensal = Math.min(saldoMensal, aDebitar);
    const doAdicional = aDebitar - daMensal;

    // Compare-and-swap: só grava se o saldo continuar sendo o que foi lido.
    // Sem isto, duas análises disparadas ao mesmo tempo poderiam gastar o mesmo
    // último crédito.
    const alterados = await tx.subscription.updateMany({
      where: { id: subscriptionId, analysesUsed: sub.analysesUsed, extraAnalyses: sub.extraAnalyses },
      data: { analysesUsed: sub.analysesUsed + daMensal, extraAnalyses: sub.extraAnalyses - doAdicional },
    });
    if (alterados.count !== 1) throw new ConcorrenciaCreditoError();

    let saldoCorrente = disponivel;
    if (daMensal > 0) {
      await registrarNaRazao(
        tx,
        {
          subscriptionId,
          kind: "CONSUMO",
          bucket: "MENSAL",
          quantity: -daMensal,
          description: emAberto ? `${descricao} (diferença de faixa por documentos acrescentados)` : descricao,
          analysisId,
          idempotencyKey: `consumo:${analysisId}:mensal${sufixo}`,
        },
        saldoCorrente,
        saldoCorrente - daMensal,
      );
      saldoCorrente -= daMensal;
    }
    if (doAdicional > 0) {
      await registrarNaRazao(
        tx,
        {
          subscriptionId,
          kind: "CONSUMO",
          bucket: "ADICIONAL",
          quantity: -doAdicional,
          description: `${descricao} (crédito adicional)`,
          analysisId,
          idempotencyKey: `consumo:${analysisId}:adicional${sufixo}`,
        },
        saldoCorrente,
        saldoCorrente - doAdicional,
      );
      saldoCorrente -= doAdicional;
    }

    // O campo guarda o TOTAL cobrado pela análise, não o débito desta chamada: no
    // complemento de faixa, `creditos` já é o total novo.
    await tx.analysis.update({ where: { id: analysisId }, data: { creditsCharged: creditos } });

    return {
      consumidos: creditos,
      daMensal: cobradoMensal + daMensal,
      doAdicional: cobradoAdicional + doAdicional,
      saldoRestante: saldoCorrente,
      jaConsumido: false,
      ...(emAberto ? { complementoCobrado: aDebitar } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Estorno
// ---------------------------------------------------------------------------

/**
 * Devolve os créditos de uma análise que falhou por problema técnico.
 *
 * Devolve cada crédito à bolsa de onde saiu: sem isso, um erro numa análise paga
 * com crédito adicional viraria crédito mensal, que expira no fim do ciclo — o
 * cliente perderia o que comprou.
 *
 * Idempotente: estornar duas vezes não credita duas vezes.
 *
 * ── ⚠️ SÓ DEVOLVE O QUE NÃO FOI ENTREGUE, e antes devolvia demais ─────────────
 * A conta era "toda cobrança em aberto desta análise". O problema é que uma cobrança BEM-SUCEDIDA fica
 * em aberto para sempre: só um estorno fecha a linha de CONSUMO, e entrega não gera estorno. Então a
 * cobrança do que o cliente JÁ RECEBEU era indistinguível da cobrança de uma execução que falhou.
 *
 * O caminho mais comum é o do reprocessamento gratuito, que é uma promessa do produto:
 *
 *   200 páginas, 1 crédito, análise ENTREGUE → o cliente reprocessa o mesmo material (grátis, como
 *   prometido) → essa rodada falha → o sistema devolvia o crédito da análise que ele já tinha em mãos.
 *
 * E a versão caríssima, com documentos acrescentados: entrega de 1 crédito, complemento de 3 pela nova
 * faixa, falha da segunda execução → devolvia 4, inclusive o crédito da entrega. Junto disso,
 * `creditsCharged` voltava a zero e a análise passava a valer 4 na cobrança seguinte.
 *
 * ── Como se distingue entregue de não entregue, sem coluna nova ────────────────
 * Pelo RELATÓRIO. Dentro de uma execução o motor cobra ANTES de chamar a IA e grava o relatório DEPOIS
 * (`analysis-runner.ts`), então toda cobrança de uma execução que entregou é mais antiga que o relatório
 * dela. A conta é: cobranças em aberto criadas DEPOIS do relatório mais recente. Sem relatório nenhum,
 * tudo em aberto é devolvível — que é o caso da falha na primeira execução.
 *
 * Os dois `createdAt` vêm do mesmo relógio (o do Postgres), então não há a defasagem que existiria
 * comparando com um horário gerado na aplicação.
 *
 * ── A escolha quando a execução falhou DEPOIS de gravar o relatório ───────────
 * Não devolve. O relatório existe, a tela do cliente o mostra (ela não olha o status para renderizar) e
 * o custo com o provedor de IA foi pago. É a mesma regra que o cancelamento já aplica — lá o crédito
 * também fica quando existe relatório. Uma regra só nos dois lugares vale mais que otimizar este canto.
 */
/**
 * Quantas vezes o estorno é retentado quando perde a corrida, e por que DEZ e não cinco.
 *
 * O compare-and-swap é sobre a linha da ASSINATURA, então estornos de análises diferentes da mesma conta
 * disputam entre si. Com cinco tentativas e espera de 10, 20, 30 e 40 ms, o orçamento total era de
 * ~100 ms — e o teste de oito pares simultâneos esgotou isso numa segunda rodada com o banco carregado:
 * um crédito ficou retido. Não é caso de laboratório, é o custo de desistir: desistir aqui significa
 * cliente que pagou, não recebeu e não teve o crédito de volta.
 *
 * Dez tentativas com espera crescente e ALEATORIZADA. A aleatoriedade importa: sem ela, as transações
 * que perdem esperam o mesmo tempo, acordam juntas e colidem de novo — a retentativa em lockstep é o que
 * transforma contenção moderada em falha.
 *
 * Não é infinito de propósito. Se dez tentativas não bastarem, algo está errado além da concorrência, e
 * aí a falha PRECISA aparecer: quem chama alerta (o motor e a varredura) ou devolve conflito para a tela.
 * Insistir para sempre esconderia o problema e prenderia a requisição.
 */
const TENTATIVAS_DO_ESTORNO = 10;

/** O mínimo de uma linha da razão para a conta do estorno. */
interface LinhaParaEstorno {
  bucket: CreditBucket | null;
  quantity: number;
  createdAt: Date;
}

/**
 * Quanto desta análise é devolvível, por bolsa — a REGRA, num lugar só.
 *
 * ── Por que foi extraída ──────────────────────────────────────────────────────
 * Duas perguntas diferentes precisam da MESMA resposta: "devolva o que é devido" (o estorno) e "há
 * crédito a perder se isto for excluído?" (o aviso na tela de exclusão). Com a conta escrita duas vezes,
 * a tela prometeria um número e o estorno devolveria outro — e a divergência apareceria justamente na
 * hora em que o cliente está decidindo apagar a análise.
 *
 * ── As três regras que ela aplica, em ordem ───────────────────────────────────
 *  1. Só linhas COM bolsa contam. O plano legado sem limite grava CONSUMO com bolsa nula e quantidade
 *     zero: nada saiu, nada volta, e contá-lo faria a comparação achar que falta devolver algo.
 *  2. Devolvido tudo o que foi cobrado? Então não há pendência. A comparação é por CONTAGEM de linhas
 *     porque a cobrança pode repetir (análise estornada e rodada de novo), e "existe algum estorno?"
 *     travaria o segundo estorno legítimo.
 *  3. O CORTE PELO RELATÓRIO separa entregue de não entregue. Cobrança de execução que ENTREGOU fica em
 *     aberto para sempre — só um estorno fecha a linha —, e somá-la devolvia ao cliente o crédito da
 *     análise que ele já tinha em mãos. O motor cobra antes de chamar a IA e grava o relatório depois,
 *     então "cobrança criada depois do relatório mais recente" é "cobrança que ainda não entregou nada".
 *
 * O `Math.max(0, …)` por bolsa importa depois do corte: os ESTORNOS já feitos podem somar mais que o
 * subconjunto não entregue (dados antigos, estornados pela regra larga), e sem o piso uma bolsa negativa
 * subtrairia da outra e o total mentiria.
 */
function calcularDevolvivel(
  consumos: LinhaParaEstorno[],
  estornos: LinhaParaEstorno[],
  relatorioEm: Date | null,
): {
  daMensal: number;
  doAdicional: number;
  total: number;
  jaEstornado: boolean;
  tentativa: number;
  /** Tudo que já saiu por esta análise, e tudo que já voltou — para o registro do líquido cobrado. */
  cobradoTotal: number;
  devolvidoTotal: number;
} {
  const comBolsa = (l: LinhaParaEstorno) => l.bucket === "MENSAL" || l.bucket === "ADICIONAL";
  const somaPorBolsa = (linhas: LinhaParaEstorno[], bolsa: "MENSAL" | "ADICIONAL") =>
    linhas.filter((l) => l.bucket === bolsa).reduce((s, l) => s + Math.abs(l.quantity), 0);

  const cobradoTotal = somaPorBolsa(consumos, "MENSAL") + somaPorBolsa(consumos, "ADICIONAL");
  const devolvidoTotal = somaPorBolsa(estornos, "MENSAL") + somaPorBolsa(estornos, "ADICIONAL");

  const cobradasComBolsa = consumos.filter(comBolsa);
  const devolvidas = estornos.filter(comBolsa);
  const tentativa = devolvidas.length;

  if (cobradasComBolsa.length === 0 || devolvidas.length >= cobradasComBolsa.length) {
    return {
      daMensal: 0,
      doAdicional: 0,
      total: 0,
      jaEstornado: devolvidas.length > 0,
      tentativa,
      cobradoTotal,
      devolvidoTotal,
    };
  }

  const naoEntregues = relatorioEm ? consumos.filter((l) => l.createdAt > relatorioEm) : consumos;
  const daMensal = Math.max(0, somaPorBolsa(naoEntregues, "MENSAL") - somaPorBolsa(estornos, "MENSAL"));
  const doAdicional = Math.max(0, somaPorBolsa(naoEntregues, "ADICIONAL") - somaPorBolsa(estornos, "ADICIONAL"));
  const total = daMensal + doAdicional;

  /**
   * Total zero com cobrança em aberto significa que o que sobrou é trabalho ENTREGUE. `jaEstornado` é a
   * resposta porque é assim que quem chama entende "não há pendência", e nenhum chamador separa os dois.
   */
  return { daMensal, doAdicional, total, jaEstornado: total <= 0, tentativa, cobradoTotal, devolvidoTotal };
}

/**
 * Quanto voltaria ao saldo se esta análise fosse CANCELADA agora. Zero = nada a perder.
 *
 * ── Para que serve ────────────────────────────────────────────────────────────
 * Para a tela poder avisar antes de EXCLUIR. Excluir apaga a análise e os documentos e não devolve
 * crédito nenhum — enquanto Cancelar, logo ao lado, devolve quando nada foi entregue. Sem o aviso, o
 * cliente que quer se livrar de uma análise que falhou escolhe o botão errado e perde o crédito sem
 * jamais saber que havia outro caminho.
 *
 * Responde pela MESMA conta do estorno (`calcularDevolvivel`), de propósito: um número na tela que não
 * seja exatamente o que o estorno devolveria é pior que nenhum número.
 */
export async function creditoDevolvivel(analysisId: string): Promise<number> {
  const subscriptionId = await assinaturaQueCobrou(analysisId);
  if (!subscriptionId) return 0;

  const [linhas, relatorio] = await Promise.all([
    prisma.creditLedger.findMany({
      where: { subscriptionId, analysisId, kind: { in: ["CONSUMO", "ESTORNO"] } },
      select: { kind: true, bucket: true, quantity: true, createdAt: true },
    }),
    prisma.report.findFirst({ where: { analysisId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);

  return calcularDevolvivel(
    linhas.filter((l) => l.kind === "CONSUMO"),
    linhas.filter((l) => l.kind === "ESTORNO"),
    relatorio?.createdAt ?? null,
  ).total;
}

/** A escrita perdeu a corrida por causa da chave única da razão — outro estorno igual já a gravou. */
function ehColisaoDeChave(err: unknown): boolean {
  return (err as { code?: string })?.code === "P2002";
}

export async function estornarCreditos(
  subscriptionId: string,
  analysisId: string,
  motivo: string,
): Promise<{ estornados: number; jaEstornado: boolean }> {
  /**
   * ⚠️ RETENTATIVA, e sem ela o conserto da concorrência TROCARIA um defeito por outro.
   *
   * O compare-and-swap lá embaixo impede a devolução em dobro fazendo a transação perdedora voltar
   * atrás. Só que o contador de saldo é da ASSINATURA, não da análise: estornos de análises DIFERENTES
   * da mesma conta disputam a mesma linha. Sem retentativa, o perdedor simplesmente desiste — e "desistir"
   * aqui significa cliente que pagou, não recebeu, e não teve o crédito de volta.
   *
   * Foi o que o teste de oito pares simultâneos mostrou: com o CAS e sem esta retentativa, sete dos oito
   * créditos voltavam e um ficava retido. Devolução em dobro virou devolução perdida.
   *
   * A retentativa é segura porque a releitura é o que resolve: na tentativa seguinte a razão já mostra o
   * estorno do vencedor, e o caminho termina em "já estornado" em vez de devolver de novo.
   *
   * Também retenta na colisão da chave única da razão (P2002): significa que outro estorno idêntico
   * gravou a linha primeiro — mesma situação, mesma saída.
   */
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await estornarUmaVez(subscriptionId, analysisId, motivo);
    } catch (err) {
      const podeRetentar = err instanceof ConcorrenciaCreditoError || ehColisaoDeChave(err);
      if (!podeRetentar || tentativa >= TENTATIVAS_DO_ESTORNO) throw err;
      /**
       * Espera crescente com ruído: o que se aguarda é a transação vencedora comitar. O ruído evita que
       * os perdedores acordem juntos e colidam de novo — ver `TENTATIVAS_DO_ESTORNO`.
       */
      await new Promise((r) => setTimeout(r, 10 * tentativa + Math.floor(Math.random() * 15)));
    }
  }
}

async function estornarUmaVez(
  subscriptionId: string,
  analysisId: string,
  motivo: string,
): Promise<{ estornados: number; jaEstornado: boolean }> {
  return prisma.$transaction(async (tx) => {
    /**
     * ⚠️ A ASSINATURA É LIDA PRIMEIRO, ANTES DA RAZÃO — e a ordem é a metade do conserto.
     *
     * Dois estornos simultâneos da mesma análise devolviam EM DOBRO, e nem a contagem CONSUMO×ESTORNO
     * nem a chave única de idempotência seguravam. O mecanismo, em READ COMMITTED (o padrão):
     *
     *   T1 lê a razão (nenhum estorno), lê a assinatura (usados = 1), devolve à bolsa MENSAL com a
     *   chave `estorno:<analise>:mensal`, e comita.
     *   T2 leu a razão ANTES de T1 comitar — então também acha que não há estorno nenhum — e lê a
     *   assinatura DEPOIS, quando `analysesUsed` já é zero. Com a mensal zerada, `absorveMensal` dá 0 e
     *   a devolução inteira escorre para a bolsa ADICIONAL, com a chave `estorno:<analise>:adicional`.
     *   Chave diferente: não colide, não é barrada, e o crédito é dado duas vezes.
     *
     * Pior: o excedente cai na bolsa ADICIONAL, que NÃO expira no fim do ciclo. Um crédito cobrado, dois
     * devolvidos, e o de brinde é o que dura mais. Dispara com dois cliques em "Cancelar análise" (duas
     * abas, retentativa de rede), ou com o cancelamento concorrente à varredura diária.
     *
     * Ler a assinatura ANTES da razão fecha a janela: a leitura da razão passa a ser sempre igual ou
     * mais nova que a da assinatura, então os dois casos possíveis são seguros — assinatura velha faz o
     * compare-and-swap lá embaixo falhar, e assinatura nova implica razão nova, que já traz o estorno de
     * T1 e cai na saída antecipada de "já estornado".
     *
     * Compare-and-swap sozinho NÃO resolveria: no cenário acima T2 lê a assinatura já atualizada, então
     * a condição casaria com o estado corrente e a escrita passaria.
     */
    const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    const saldoAntes = totalDe(sub);

    const consumos = await tx.creditLedger.findMany({
      where: { subscriptionId, analysisId, kind: "CONSUMO" },
    });
    if (consumos.length === 0) return { estornados: 0, jaEstornado: false };

    /**
     * Já estornado? Só se TODAS as cobranças já tiverem sido devolvidas.
     *
     * A checagem era "existe algum ESTORNO desta análise?", e com a cobrança podendo
     * repetir (análise estornada e rodada de novo) isso travaria o segundo estorno: a
     * segunda cobrança ficaria sem devolução possível. A comparação é por CONTAGEM.
     */
    const estornosFeitos = await tx.creditLedger.findMany({
      where: { subscriptionId, analysisId, kind: "ESTORNO" },
    });
    /**
     * Só linhas COM bolsa entram na conta dos dois lados. O registro do plano
     * ilimitado grava CONSUMO com `bucket: null` e quantidade zero — nada a estornar —,
     * e contá-lo faria a comparação achar que falta devolver algo que nunca saiu.
     */
    const ultimoRelatorio = await tx.report.findFirst({
      where: { analysisId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    const calculo = calcularDevolvivel(consumos, estornosFeitos, ultimoRelatorio?.createdAt ?? null);
    if (calculo.total <= 0) return { estornados: 0, jaEstornado: calculo.jaEstornado };
    const { daMensal, doAdicional, total, tentativa } = calculo;
    const sufixo = tentativa > 0 ? `:t${tentativa}` : "";

    /**
     * ⚠️ ESTORNO DEPOIS DA VIRADA DE CICLO devolvia NADA.
     *
     * Devolver à bolsa mensal significa desfazer consumo: `analysesUsed - daMensal`. Isso
     * pressupõe que o consumo ainda está lá — e depois da virada do ciclo não está. A
     * liberação do ciclo novo zera `analysesUsed`, então `Math.max(0, 0 - 1)` continuava
     * zero: o extrato registrava a devolução de um crédito, o saldo não mudava em nada, e
     * as duas versões passavam a discordar. Neste arquivo o extrato é a fonte da verdade,
     * e ele estava prometendo o que o contador não entregava.
     *
     * Acontece sempre que a análise falha perto da virada: o processamento morre, a
     * varredura de manutenção estorna na madrugada seguinte, e o ciclo já virou.
     *
     * A conta agora é o que a bolsa mensal CONSEGUE absorver; o resto vai para a bolsa
     * adicional, que não expira com o ciclo. Duas razões para ser a adicional, e não
     * aumentar a cota do plano: a cota do plano é a promessa da oferta (mostrar "21 de 20"
     * confunde mais do que informa), e o crédito que sobrou de um ciclo encerrado não pode
     * ganhar validade de um ciclo que o cliente não escolheu. Errar aqui para o lado do
     * cliente é o certo: a falha foi NOSSA.
     */
    const absorveMensal = Math.min(daMensal, sub.analysesUsed);
    const sobraParaAdicional = daMensal - absorveMensal;
    const paraAdicional = doAdicional + sobraParaAdicional;

    /**
     * ⚠️ COMPARE-AND-SWAP, como no consumo — era `update` cego a partir de leitura velha.
     *
     * `consumirCreditos` se protege assim desde sempre (`updateMany` condicionado ao saldo lido); o
     * estorno, que mexe no mesmo contador, não. Com a leitura da assinatura movida para o topo desta
     * transação, esta condição é o que barra o estorno concorrente cuja leitura ficou para trás: a
     * escrita não encontra a linha, `count` é zero, e a transação inteira volta atrás.
     *
     * O erro é de CONCORRÊNCIA, não de pedido — quem chama trata como "tente de novo", e a segunda
     * tentativa cai na saída antecipada de "já estornado". Ver `ConcorrenciaCreditoError`.
     */
    const alterados = await tx.subscription.updateMany({
      where: { id: subscriptionId, analysesUsed: sub.analysesUsed, extraAnalyses: sub.extraAnalyses },
      data: {
        analysesUsed: sub.analysesUsed - absorveMensal,
        extraAnalyses: sub.extraAnalyses + paraAdicional,
      },
    });
    if (alterados.count !== 1) throw new ConcorrenciaCreditoError();

    let saldoCorrente = saldoAntes;
    if (absorveMensal > 0) {
      await registrarNaRazao(
        tx,
        {
          subscriptionId,
          kind: "ESTORNO",
          bucket: "MENSAL",
          quantity: absorveMensal,
          description: `Estorno automático: ${motivo}`,
          analysisId,
          reason: motivo,
          idempotencyKey: `estorno:${analysisId}:mensal${sufixo}`,
        },
        saldoCorrente,
        saldoCorrente + absorveMensal,
      );
      saldoCorrente += absorveMensal;
    }
    if (paraAdicional > 0) {
      /**
       * A descrição diz de onde veio quando a bolsa mensal não pôde receber. Sem isso, o
       * cliente veria "crédito adicional" sem ter comprado nenhum, e o extrato — que
       * existe justamente para ele conferir sozinho — geraria a dúvida que deveria evitar.
       */
      const explicacao =
        sobraParaAdicional > 0
          ? `${motivo} (devolvido como crédito adicional: o ciclo do consumo já havia virado)`
          : `${motivo} (crédito adicional)`;
      await registrarNaRazao(
        tx,
        {
          subscriptionId,
          kind: "ESTORNO",
          bucket: "ADICIONAL",
          quantity: paraAdicional,
          description: `Estorno automático: ${explicacao}`,
          analysisId,
          reason: motivo,
          idempotencyKey: `estorno:${analysisId}:adicional${sufixo}`,
        },
        saldoCorrente,
        saldoCorrente + paraAdicional,
      );
      saldoCorrente += paraAdicional;
    }

    /**
     * ⚠️ `creditsCharged` recebe o que SOBRA cobrado, não zero.
     *
     * Zerar era a segunda metade do mesmo furo: com a devolução parcial, a análise de 4 créditos passava
     * a registrar zero cobrado. A rota de processar lê este campo para decidir se a execução conta como
     * reprocessamento (`jaRodou`), e o extrato interno o usa como "quanto esta análise custou" — os dois
     * passavam a afirmar que ela nunca foi cobrada, com o crédito da entrega ainda debitado de verdade.
     *
     * O valor certo é o líquido: tudo que foi cobrado, menos tudo que já voltou (inclusive agora).
     */
    const restanteCobrado = Math.max(0, calculo.cobradoTotal - calculo.devolvidoTotal - total);
    await tx.analysis.update({ where: { id: analysisId }, data: { creditsCharged: restanteCobrado } });

    return { estornados: total, jaEstornado: false };
  });
}

// ---------------------------------------------------------------------------
// Liberação do ciclo
// ---------------------------------------------------------------------------

/** Chave do ciclo (AAAA-MM), usada na idempotência da liberação mensal. */
/**
 * Assinaturas que JÁ receberam liberação de cota no mês civil de `referencia`.
 *
 * Existe para que o painel do administrador e a rotina do plano anual respondam a
 * mesma pergunta pelo mesmo caminho. Antes, os dois procuravam a CHAVE
 * `ciclo:<id>:<AAAA-MM>` — e no instante em que a chave do pagamento deixou de ser o
 * mês, essa busca passaria a não encontrar nada: o painel listaria todo mundo como
 * pendente e o cron do anual liberaria uma segunda cota no mês do pagamento.
 *
 * A pergunta certa não é "existe um lançamento com esta chave?", e sim "houve
 * liberação de cota neste mês?". É isso que esta função responde, em uma consulta
 * para todas as assinaturas de uma vez.
 */
export async function assinaturasComCotaNoMes(
  subscriptionIds: string[],
  referencia: Date = new Date(),
): Promise<Set<string>> {
  if (subscriptionIds.length === 0) return new Set();
  const inicio = new Date(Date.UTC(referencia.getUTCFullYear(), referencia.getUTCMonth(), 1));
  const fim = new Date(Date.UTC(referencia.getUTCFullYear(), referencia.getUTCMonth() + 1, 1));
  const lancamentos = await prisma.creditLedger.findMany({
    where: {
      subscriptionId: { in: subscriptionIds },
      kind: "ASSINATURA",
      quantity: { gt: 0 },
      createdAt: { gte: inicio, lt: fim },
    },
    select: { subscriptionId: true },
  });
  return new Set(lancamentos.map((l) => l.subscriptionId));
}

export function chaveDoCiclo(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface ResultadoLiberacao {
  liberados: number;
  expirados: number;
  jaLiberado: boolean;
  proximoCiclo: Date;
}

/**
 * Libera os créditos do ciclo. Vale tanto para a renovação mensal quanto para o
 * mês seguinte de um plano anual — no anual o cliente paga uma vez, mas recebe
 * os créditos mês a mês, nunca o ano inteiro de uma vez.
 *
 * Idempotente pela chave `ciclo:<assinatura>:<AAAA-MM>`: o gateway pode reenviar
 * o mesmo evento, ou mandar dois eventos diferentes no mesmo mês, que os
 * créditos são liberados uma vez só.
 *
 * O que sobrou da bolsa mensal expira aqui — é o que diferencia crédito mensal
 * (não acumula) de crédito adicional comprado (dura 90 dias).
 */
export async function liberarCreditosDoCiclo(
  subscriptionId: string,
  opcoes: { referencia?: Date; creditos?: number; descricao?: string; ciclo?: string } = {},
): Promise<ResultadoLiberacao> {
  const referencia = opcoes.referencia ?? new Date();
  /**
   * A IDENTIDADE DO CICLO vem de quem chama, e não do calendário.
   *
   * A chave era sempre `ciclo:<id>:<AAAA-MM>`: uma liberação por MÊS CIVIL. Parece
   * inofensivo e não é, porque ciclo de assinatura não anda em mês civil. Um
   * pagamento atrasado basta para quebrar: cobrança de 28/08 paga em 02/09 libera o
   * mês 09; a cobrança seguinte, de 28/09, cai no MESMO mês civil e libera ZERO —
   * o cliente paga e não recebe crédito, e o consumo do ciclo anterior nem é zerado.
   * Dois boletos em aberto pagos no mesmo dia tinham o mesmo destino.
   *
   * Quem paga uma cobrança compra um ciclo, então a identidade natural do ciclo é o
   * PAGAMENTO: `ciclo:<id>:pag:<idDoPagamento>`. Isso também torna o reenvio do
   * webhook idempotente de graça — o par CONFIRMED→RECEIVED traz o mesmo pagamento.
   *
   * O recuo no mês civil fica para as liberações que NÃO nascem de um pagamento: a
   * cota mensal do plano anual e o botão do administrador, onde "uma por mês" é
   * exatamente a regra desejada.
   */
  const chave = `ciclo:${subscriptionId}:${opcoes.ciclo ?? chaveDoCiclo(referencia)}`;

  return prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: { plan: true },
    });

    const proximoCiclo = new Date(referencia);
    proximoCiclo.setMonth(proximoCiclo.getMonth() + 1);

    const existente = await tx.creditLedger.findUnique({ where: { idempotencyKey: chave } });
    if (existente) {
      return { liberados: 0, expirados: 0, jaLiberado: true, proximoCiclo };
    }

    const cota = opcoes.creditos ?? sub.plan.monthlyAnalyses;

    /**
     * PRIMEIRA liberação não expira nada — e isto apareceu num pagamento real.
     *
     * `ativarAssinatura` grava `analysesQuota` do plano ANTES de chamar esta função
     * (e precisa gravar: se a liberação falhasse, uma cota 0 significaria acesso
     * ILIMITADO). O efeito colateral é que a primeira liberação enxergava 20 créditos
     * "sobrando de um ciclo anterior" que nunca existiu, e o extrato do cliente
     * abria assim, no minuto da compra:
     *
     *   -20  Créditos mensais não utilizados no ciclo anterior
     *   +20  Créditos liberados pela assinatura
     *
     * O saldo final ficava certo, mas o cliente lia que perdeu 20 análises no dia em
     * que pagou — e os campos de saldo anterior/posterior da razão descreviam um
     * histórico inventado. `creditsReleasedAt` nulo é a prova de que nunca houve
     * liberação: sem liberação anterior, não há sobra possível.
     */
    const primeiraLiberacao = sub.creditsReleasedAt === null;
    const saldoAntes = primeiraLiberacao ? Math.max(0, sub.extraAnalyses) : totalDe(sub);
    const sobra = primeiraLiberacao ? 0 : Math.max(0, sub.analysesQuota - sub.analysesUsed);

    // 1) O que sobrou do ciclo anterior expira.
    if (sobra > 0) {
      await registrarNaRazao(
        tx,
        {
          subscriptionId,
          kind: "EXPIRACAO",
          bucket: "MENSAL",
          quantity: -sobra,
          description: `Créditos mensais não utilizados no ciclo anterior`,
          idempotencyKey: `expiracao:${subscriptionId}:${chaveDoCiclo(referencia)}`,
        },
        saldoAntes,
        saldoAntes - sobra,
      );
    }

    // 2) Zera o ciclo e libera a nova cota.
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        analysesQuota: cota,
        analysesUsed: 0,
        creditsReleasedAt: referencia,
        cycleEndsAt: proximoCiclo,
        maxUsers: sub.plan.maxUsers,
      },
    });

    const saldoAposExpiracao = saldoAntes - sobra;
    await registrarNaRazao(
      tx,
      {
        subscriptionId,
        kind: "ASSINATURA",
        bucket: "MENSAL",
        quantity: cota,
        description: opcoes.descricao ?? `Créditos liberados pela assinatura do plano ${sub.plan.name}`,
        idempotencyKey: chave,
      },
      saldoAposExpiracao,
      saldoAposExpiracao + cota,
    );

    return { liberados: cota, expirados: sobra, jaLiberado: false, proximoCiclo };
  });
}

// ---------------------------------------------------------------------------
// Créditos adicionais (pacotes)
// ---------------------------------------------------------------------------

/**
 * Credita um pacote avulso. `idempotencyKey` deve carregar o identificador do
 * pagamento, para que o reenvio do webhook não credite o pacote duas vezes.
 */
export async function creditarPacote(
  subscriptionId: string,
  creditos: number,
  opcoes: {
    validadeDias?: number;
    paymentId?: string | null;
    idempotencyKey: string;
    descricao?: string;
  },
): Promise<{ creditados: number; jaCreditado: boolean; expiraEm: Date }> {
  const validadeDias = opcoes.validadeDias ?? 90;
  const expiraEm = new Date(Date.now() + validadeDias * 86_400_000);

  return prisma.$transaction(async (tx) => {
    const existente = await tx.creditLedger.findUnique({ where: { idempotencyKey: opcoes.idempotencyKey } });
    if (existente) return { creditados: 0, jaCreditado: true, expiraEm };

    const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    const saldoAntes = totalDe(sub);

    await tx.subscription.update({
      where: { id: subscriptionId },
      data: { extraAnalyses: sub.extraAnalyses + creditos },
    });

    await registrarNaRazao(
      tx,
      {
        subscriptionId,
        kind: "COMPRA_ADICIONAL",
        bucket: "ADICIONAL",
        quantity: creditos,
        description: opcoes.descricao ?? (creditos === 1 ? "Compra de 1 crédito avulso" : `Compra de ${creditos} créditos avulsos`),
        paymentId: opcoes.paymentId ?? null,
        expiresAt: expiraEm,
        idempotencyKey: opcoes.idempotencyKey,
      },
      saldoAntes,
      saldoAntes + creditos,
    );

    return { creditados: creditos, jaCreditado: false, expiraEm };
  });
}

/**
 * Expira créditos adicionais vencidos. Roda no worker; é seguro chamar quantas
 * vezes for preciso, porque só olha entradas ainda não expiradas.
 */
export async function expirarCreditosAdicionais(agora: Date = new Date()): Promise<number> {
  const vencidos = await prisma.creditLedger.findMany({
    where: { kind: "COMPRA_ADICIONAL", expiresAt: { lte: agora } },
    select: { id: true, subscriptionId: true, quantity: true, expiresAt: true },
  });

  let totalExpirado = 0;
  for (const entrada of vencidos) {
    const chave = `expiracao-pacote:${entrada.id}`;
    const ja = await prisma.creditLedger.findUnique({ where: { idempotencyKey: chave } });
    if (ja) continue;

    await prisma.$transaction(async (tx) => {
      const sub = await tx.subscription.findUnique({ where: { id: entrada.subscriptionId } });
      if (!sub) return;
      // Só expira o que ainda existe: se o cliente já gastou, não há o que tirar.
      const aExpirar = Math.min(entrada.quantity, sub.extraAnalyses);
      const saldoAntes = totalDe(sub);

      if (aExpirar > 0) {
        await tx.subscription.update({
          where: { id: sub.id },
          data: { extraAnalyses: sub.extraAnalyses - aExpirar },
        });
      }
      await registrarNaRazao(
        tx,
        {
          subscriptionId: sub.id,
          kind: "EXPIRACAO",
          bucket: "ADICIONAL",
          quantity: -aExpirar,
          description: `Créditos adicionais expirados (validade de ${entrada.expiresAt?.toLocaleDateString("pt-BR")})`,
          idempotencyKey: chave,
        },
        saldoAntes,
        saldoAntes - aExpirar,
      );
      totalExpirado += aExpirar;
    });
  }
  return totalExpirado;
}

// ---------------------------------------------------------------------------
// Ajuste manual da administração
// ---------------------------------------------------------------------------

/**
 * Lança ou retira crédito manualmente. Exige motivo e responsável — o extrato
 * precisa responder quem fez, quando e por quê.
 */
export async function ajustarCreditosAdmin(
  subscriptionId: string,
  quantidade: number,
  opcoes: { actorId: string; motivo: string; bonus?: boolean; validadeDias?: number },
): Promise<{ saldoAnterior: number; saldoPosterior: number }> {
  if (quantidade === 0) throw new Error("Informe uma quantidade diferente de zero.");
  if (!opcoes.motivo.trim()) throw new Error("Informe o motivo do ajuste.");

  const resultado = await prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    const saldoAntes = totalDe(sub);

    // Ajuste manual sempre mexe na bolsa adicional: a mensal é reescrita a cada
    // renovação e o lançamento se perderia no ciclo seguinte.
    const novoExtra = sub.extraAnalyses + quantidade;
    if (novoExtra < 0) throw new SaldoInsuficienteError(Math.abs(quantidade), sub.extraAnalyses);

    await tx.subscription.update({ where: { id: subscriptionId }, data: { extraAnalyses: novoExtra } });

    await registrarNaRazao(
      tx,
      {
        subscriptionId,
        kind: opcoes.bonus ? "BONUS" : "AJUSTE_ADMIN",
        bucket: "ADICIONAL",
        quantity: quantidade,
        description: opcoes.bonus
          ? `Bônus promocional de ${quantidade} créditos`
          : `Ajuste administrativo de ${quantidade > 0 ? "+" : ""}${quantidade} créditos`,
        actorId: opcoes.actorId,
        reason: opcoes.motivo,
        expiresAt: opcoes.validadeDias ? new Date(Date.now() + opcoes.validadeDias * 86_400_000) : null,
      },
      saldoAntes,
      saldoAntes + quantidade,
    );

    return { saldoAnterior: saldoAntes, saldoPosterior: saldoAntes + quantidade };
  });

  await logAudit({
    actorId: opcoes.actorId,
    action: opcoes.bonus ? "credits.bonus" : "credits.adjust",
    entityType: "Subscription",
    entityId: subscriptionId,
    metadata: {
      quantidade,
      motivo: opcoes.motivo,
      saldoAnterior: resultado.saldoAnterior,
      saldoPosterior: resultado.saldoPosterior,
    },
  });

  return resultado;
}

// ---------------------------------------------------------------------------
// Extrato
// ---------------------------------------------------------------------------

export const ROTULO_MOVIMENTO: Record<CreditMovementKind, string> = {
  ASSINATURA: "Crédito liberado pela assinatura",
  CONSUMO: "Crédito utilizado",
  ESTORNO: "Crédito estornado",
  COMPRA_ADICIONAL: "Crédito adicional comprado",
  EXPIRACAO: "Crédito expirado",
  AJUSTE_ADMIN: "Ajuste administrativo",
  BONUS: "Bônus promocional",
};

export async function extratoDeCreditos(subscriptionId: string, limite = 100) {
  return prisma.creditLedger.findMany({
    where: { subscriptionId },
    orderBy: { createdAt: "desc" },
    take: limite,
    include: {
      analysis: { select: { id: true, title: true } },
      payment: { select: { id: true, externalId: true, amountCents: true } },
      actor: { select: { id: true, name: true } },
    },
  });
}
