import { prisma } from "./db";
import { logAudit } from "./audit";
import { assinaturasComCotaNoMes, liberarCreditosDoCiclo } from "./credits";
import { sendEmail, renderEmail } from "./email";
import { randomToken, sha256 } from "./crypto";
import { env } from "./env";
import { garantirOrganizacao } from "./tenant";
import { ehRecorrencia } from "./asaas";
import { alertarOperacao, emReais } from "./alerta-operacional";
import { emitirVerificacaoDeEmail } from "./verificacao-email";
import { cancelarTrocaDeEmailPendente } from "./troca-de-email";
import type { Subscription } from "@prisma/client";

/**
 * Liberação manual de acesso — vendas que não passam pelo gateway.
 *
 * Por que existe: as rotas de admin só sabiam agir sobre assinatura QUE JÁ
 * EXISTE (suspender/reativar/cancelar). Quem pagava por PIX, transferência,
 * boleto, contrato empresarial ou plano "sob consulta" (Plan.contactOnly) só
 * entrava se alguém inserisse linhas à mão em Organization + Subscription +
 * CreditLedger no Postgres. Dinheiro recebido, produto não entregue.
 *
 * Também serve de rede de segurança quando o webhook do provedor falha: o
 * cliente pagou de verdade, o evento não chegou, e o dono precisa liberar sem
 * esperar suporte técnico.
 *
 * Tudo aqui é idempotente por natureza ou explicitamente registrado em
 * auditoria: liberar acesso é operação sensível e precisa deixar rastro de quem
 * fez, para quem, com que motivo.
 */

export interface EntradaAtivacao {
  /** E-mail do cliente. Se não existir conta, é criada. */
  email: string;
  /** Nome do cliente — obrigatório apenas quando a conta não existe. */
  nome?: string;
  planoSlug: string;
  /** Valor efetivamente recebido, em centavos. Se ausente, usa o preço do plano. */
  valorCents?: number;
  /** Forma de pagamento registrada (pix, transferencia, boleto, contrato...). */
  metodo?: string;
  /** Obrigatório: por que este acesso está sendo liberado à mão. */
  motivo: string;
  /** Enviar ao cliente o e-mail com link para criar senha (conta nova). */
  enviarConvite?: boolean;
}

export interface ResultadoAtivacao {
  subscriptionId: string;
  usuarioId: string;
  usuarioCriado: boolean;
  creditosLiberados: number;
  conviteEnviado: boolean;
  avisoConvite?: string;
  /**
   * A conta já tinha cobrança automática no provedor, que CONTINUA valendo.
   *
   * Preenchido, é para ir à tela de quem acabou de liberar: só essa pessoa sabe se a
   * recorrência deve continuar (o webhook falhou e ela é legítima) ou ser encerrada (a
   * venda passou a ser por fora, e manter as duas cobra o cliente duas vezes).
   */
  avisoCobrancaAutomatica?: string;
}

function fimDoPeriodo(period: string): Date {
  const d = new Date();
  if (period === "ANUAL") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

/**
 * Libera acesso manualmente: garante usuário, organização e assinatura ATIVA, e
 * solta os créditos do ciclo corrente.
 */
export async function ativarAssinaturaManual(
  entrada: EntradaAtivacao,
  ator: { id: string },
): Promise<ResultadoAtivacao> {
  const email = entrada.email.trim().toLowerCase();
  const motivo = entrada.motivo.trim();
  if (!motivo) throw new Error("Informe o motivo da liberação manual.");

  const plano = await prisma.plan.findUnique({ where: { slug: entrada.planoSlug } });
  if (!plano) throw new Error(`Plano "${entrada.planoSlug}" não encontrado.`);

  // 1) Usuário: reaproveita se existir, para não criar conta duplicada.
  let user = await prisma.user.findUnique({ where: { email } });
  let usuarioCriado = false;
  if (!user) {
    const nome = (entrada.nome ?? "").trim();
    if (!nome) throw new Error("Esta conta não existe ainda. Informe o nome do cliente para criá-la.");
    user = await prisma.user.create({
      data: {
        email,
        name: nome,
        role: "CLIENTE",
        // Sem senha ainda: o acesso vem pelo link de criação de senha. A conta
        // não fica pendente de verificação porque a venda já foi confirmada por
        // fora — o dono está atestando o pagamento.
        status: "ATIVO",
        emailVerifiedAt: new Date(),
      },
    });
    usuarioCriado = true;
  }

  // 2) Organização própria — mesma regra do cadastro e do webhook.
  const org = await garantirOrganizacao(user.id, user.name);

  // 3) Assinatura: atualiza a existente ou cria.
  const valor = entrada.valorCents ?? plano.priceCents;
  const fim = fimDoPeriodo(plano.period);
  const existente = await prisma.subscription.findFirst({
    where: { organizationId: org.id },
    orderBy: { createdAt: "desc" },
  });

  /**
   * A conta já tem uma cobrança que se repete sozinha no provedor?
   *
   * ── Por que se pergunta ANTES da atualização ──────────────────────────────────
   * Porque a atualização apaga a resposta: ela grava `nextRenewalAt: null`, que é
   * exatamente o sinal lido aqui. Depois de ativar não há mais como saber.
   *
   * ── Por que isto não BLOQUEIA a liberação ─────────────────────────────────────
   * Foi a decisão do dono, e a razão é o segundo propósito desta função: ser a rede de
   * segurança de quando o webhook do provedor falha. Nesse caso o cliente pagou POR
   * CARTÃO — a recorrência viva é justamente o esperado —, ele está fora do ar tendo
   * pagado, e o dono está aqui para consertar. Recusar ali transformaria "pagou e não
   * liberou" em "pagou, não liberou, e o remédio se recusa a agir".
   *
   * Encerrar a recorrência sozinho seria pior no mesmo caso: ela é legítima e está
   * pagando: o sistema tiraria do ar a cobrança de um cliente que quer continuar.
   *
   * Então libera e conta — na hora, para quem está na tela e sabe por que está fazendo
   * isso, e em alerta com registro, para não se perder quando vier por script ou quando
   * alguém passar direto pela tela.
   *
   * ── Por que o sinal é local, sem perguntar ao Asaas ───────────────────────────
   * Uma chamada de rede aqui poderia falhar, e esta função não pode: ela é o remédio de
   * quando a integração está quebrada. `externalRef` apontando para uma recorrência
   * (`sub_...`) mais `nextRenewalAt` preenchido é a nossa própria afirmação de que o
   * provedor vai cobrar de novo — boa o bastante para chamar alguém, que confere no
   * painel. (Recorrência que ficou viva por FALHA no cancelamento tem `nextRenewalAt`
   * nulo e não é vista aqui; aquele caso já tem alerta próprio.)
   */
  const cobrancaAutomaticaViva =
    existente && ehRecorrencia(existente.externalRef) && existente.nextRenewalAt !== null
      ? {
          recorrencia: existente.externalRef!,
          proximaCobranca: existente.nextRenewalAt,
          valorCents: existente.amountCents,
        }
      : null;

  /**
   * ⚠️ `nextRenewalAt` FICA NULO, e isto não é detalhe de campo.
   *
   * Em toda a aplicação `nextRenewalAt` preenchido significa uma coisa só: "esta
   * assinatura se cobra sozinha" (ver `ativarAssinatura`). É o que a Política de
   * Assinatura publica, e MANUAL é justamente o contrário — a venda aconteceu FORA do
   * gateway, não existe mandato de débito, e nada aqui nem no provedor vai cobrar de
   * novo. Estender depende de alguém liberar à mão outra vez.
   *
   * Preenchido, ele mentia em três lugares ao mesmo tempo:
   *
   *  - Na tela do cliente. `renovacaoDe` lê o campo e escreve "Próxima cobrança" com
   *    "renovação automática". O cliente lia uma data, não fazia nada, e descobria que
   *    não renovou quando o acesso parou — o mesmo defeito que o PIX já teve.
   *
   *  - Na rota do boleto. Ela recusa quem tem `nextRenewalAt` para não criar cobrança
   *    dupla, e o docblock dela nomeia a liberação manual como caso SEGURO. Duas partes
   *    escritas para concordar discordavam pelo dado: o cliente de venda manual que
   *    quisesse passar a pagar por boleto era recusado com um motivo falso.
   *
   *  - No MRR. `encerrarAssinaturasVencidas` encerra quem tem `nextRenewalAt` nulo e
   *    deixa em paz quem tem data, porque "quem decide o fim dela é o gateway". MANUAL
   *    tem data e NÃO tem gateway: nunca era encerrada. Ficava ATIVA para sempre, e
   *    toda venda manual que um dia venceu seguia somando no MRR e em "Assinantes
   *    ativos" — exatamente a mentira que aquela varredura existe para consertar. O
   *    acesso parava na hora certa (`subscriptionAccess` olha o fim do período), então
   *    o furo não era de acesso: era no número pelo qual o dono conduz o negócio.
   */
  let sub: Subscription;
  if (existente) {
    sub = await prisma.subscription.update({
      where: { id: existente.id },
      data: {
        planId: plano.id,
        status: "ATIVA",
        provider: "MANUAL",
        amountCents: valor,
        currentPeriodEnd: fim,
        nextRenewalAt: null,
        maxUsers: plano.maxUsers,
        canceledAt: null,
        canceledReason: null,
        /**
         * ⚠️ O PEDIDO DE PARADA também é apagado aqui, e faltava.
         *
         * `canceledByRequestAt` é a marca imutável de "o cliente mandou parar de
         * cobrar", e a regra dela é escrita em `canceladaAPedido`: nada além de uma
         * CONTRATAÇÃO NOVA a apaga. Liberação manual é contratação nova — o dono está
         * atestando uma venda —, mas o campo era criado junto com a marca e a ativação
         * pelo Asaas foi a única das duas atualizada.
         *
         * Deixado para trás, ele estragava três coisas para quem cancelou e depois
         * comprou de novo por fora: a tela descrevia a assinatura recém-paga como
         * "cancelada — não haverá novas cobranças" (`renovacaoDe` lê este campo antes
         * de tudo), o botão de cancelar desaparecia (assinatura paga sem saída dentro
         * do produto), e a garantia anti-ressurreição podia recusar um pagamento
         * legítimo depois — dinheiro entrando sem liberar acesso, que é a falha mais
         * cara que este projeto já teve.
         */
        canceledByRequestAt: null,
        suspendedAt: null,
        graceUntil: null,
        reactivatedAt: new Date(),
      },
    });
  } else {
    sub = await prisma.subscription.create({
      data: {
        organizationId: org.id,
        planId: plano.id,
        status: "ATIVA",
        provider: "MANUAL",
        amountCents: valor,
        currentPeriodEnd: fim,
        nextRenewalAt: null,
        maxUsers: plano.maxUsers,
        analysesQuota: plano.monthlyAnalyses,
      },
    });
  }

  // 4) Registro do pagamento recebido por fora, para o histórico do cliente e o
  // fechamento financeiro não terem um acesso ativo sem contrapartida.
  await prisma.payment.create({
    data: {
      subscriptionId: sub.id,
      provider: "MANUAL",
      status: "APROVADO",
      amountCents: valor,
      method: entrada.metodo?.trim() || "manual",
      paidAt: new Date(),
    },
  });

  // 5) Créditos do ciclo. Idempotente pela chave do mês: repetir a liberação no
  // mesmo mês não dobra a cota.
  const lib = await liberarCreditosDoCiclo(sub.id, {
    creditos: plano.monthlyAnalyses,
    descricao: `Liberação manual — plano ${plano.name} — ${motivo}`,
  });

  await logAudit({
    actorId: ator.id,
    actorRole: "ADMIN",
    action: "admin.subscription.manual_activate",
    entityType: "Subscription",
    entityId: sub.id,
    metadata: {
      email,
      plano: plano.slug,
      valorCents: valor,
      metodo: entrada.metodo ?? "manual",
      motivo,
      usuarioCriado,
      creditosLiberados: lib.liberados,
      recorrenciaQueSegueViva: cobrancaAutomaticaViva?.recorrencia ?? null,
    },
  });

  /**
   * 5.1) A cobrança automática que já existia CONTINUA valendo — e alguém precisa decidir.
   *
   * Este é o único caminho do sistema em que duas cobranças pelo mesmo acesso podem
   * conviver sem que nada tenha errado: a liberação manual não sabe se está substituindo a
   * cobrança do provedor (venda que passou a ser por fora) ou apenas cobrindo uma falha de
   * webhook na cobrança dele. As duas hipóteses pedem ações opostas, e só quem liberou sabe
   * qual é.
   *
   * O que acontece se ninguém decidir não é dinheiro perdido, e vale dizer com precisão: a
   * próxima cobrança do provedor ENTRA e ESTENDE o período pago (`ativarAssinatura` soma a
   * partir do fim já pago). O cliente paga duas vezes e recebe dois ciclos. O problema é o
   * consentimento — ele não pediu para ser cobrado duas vezes no mês — e a conciliação, que
   * passa a ter duas entradas para um acesso.
   */
  if (cobrancaAutomaticaViva) {
    await alertarOperacao({
      tipo: "ativacao_manual_com_cobranca_automatica",
      assunto: "Acesso liberado à mão para quem já tem cobrança automática",
      linhas: [
        `Cliente: ${email}.`,
        `Recorrência que segue viva no Asaas: ${cobrancaAutomaticaViva.recorrencia}.`,
        `Ela cobraria ${emReais(cobrancaAutomaticaViva.valorCents)} em ` +
          `${cobrancaAutomaticaViva.proximaCobranca.toLocaleDateString("pt-BR")}.`,
        `Liberação manual: ${plano.name}, ${emReais(valor)}, ${entrada.metodo ?? "manual"} — ${motivo}.`,
        "O acesso está ATIVO. A cobrança do provedor NÃO foi interrompida.",
      ],
      acao:
        "Decida qual das duas cobranças fica. Se a liberação foi para consertar falha de webhook," +
        " a recorrência é legítima e não há nada a fazer. Se a venda passou a ser por fora, encerre a" +
        " recorrência pela ação 'Interromper cobrança' do painel — mantidas as duas, o cliente é" +
        " cobrado duas vezes por mês (recebendo dois ciclos de acesso, mas sem ter pedido isso).",
      metadata: {
        source: "ativacao_manual",
        subscriptionId: sub.id,
        recorrencia: cobrancaAutomaticaViva.recorrencia,
        proximaCobranca: cobrancaAutomaticaViva.proximaCobranca,
        valorRecorrenciaCents: cobrancaAutomaticaViva.valorCents,
        valorLiberacaoCents: valor,
      },
    });
  }

  // 6) Convite para criar senha, quando a conta é nova.
  let conviteEnviado = false;
  let avisoConvite: string | undefined;
  if (usuarioCriado && entrada.enviarConvite !== false) {
    try {
      const token = randomToken(32);
      await prisma.authToken.create({
        data: {
          userId: user.id,
          type: "CRIACAO_SENHA",
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        },
      });
      const url = `${env.appUrl}/criar-senha?token=${token}`;
      await sendEmail({
        to: email,
        subject: "Seu acesso ao Prescrição Pro está liberado",
        html: renderEmail(
          "Acesso liberado",
          `<p>Olá, ${user.name}.</p><p>Seu acesso ao plano <strong>${plano.name}</strong> foi liberado. Crie sua senha para entrar.</p>`,
          { label: "Criar minha senha", url },
        ),
        text: `Seu acesso ao plano ${plano.name} foi liberado. Crie sua senha: ${url}`,
      });
      conviteEnviado = true;
    } catch (err) {
      // O acesso já está liberado; o e-mail é conveniência. Não desfazemos a
      // ativação por causa da notificação — apenas avisamos o operador.
      avisoConvite = (err as Error).message;
      console.error("[ativacao-manual] acesso liberado, mas o convite NÃO foi enviado:", avisoConvite);
    }
  }

  return {
    subscriptionId: sub.id,
    usuarioId: user.id,
    usuarioCriado,
    creditosLiberados: lib.liberados,
    conviteEnviado,
    avisoConvite,
    avisoCobrancaAutomatica: cobrancaAutomaticaViva
      ? `Esta conta já tem cobrança automática no Asaas (${cobrancaAutomaticaViva.recorrencia}), de ` +
        `${emReais(cobrancaAutomaticaViva.valorCents)} em ` +
        `${cobrancaAutomaticaViva.proximaCobranca.toLocaleDateString("pt-BR")}, e ela NÃO foi interrompida. ` +
        "Se esta liberação foi para consertar falha de webhook, está certo assim. Se a venda passou a ser " +
        "por fora, encerre a recorrência em Assinaturas → Interromper cobrança, senão o cliente será " +
        "cobrado duas vezes."
      : undefined,
  };
}

/**
 * Corrige o e-mail de uma conta.
 *
 * Existe porque e-mail digitado errado no checkout era irreversível pela tela: a
 * rota de usuários só aceitava `status` e `role`. O link de criação de senha ia
 * para o endereço errado e "esqueci minha senha" reenviava para o mesmo lugar —
 * cliente pagava e nunca entrava, sem que ninguém pudesse corrigir uma letra.
 */
export async function corrigirEmail(
  userId: string,
  novoEmail: string,
  ator: { id: string },
): Promise<{ de: string; para: string }> {
  const email = novoEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("E-mail inválido.");

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("Usuário não encontrado.");
  if (user.email === email) throw new Error("O e-mail informado é igual ao atual.");

  const ocupado = await prisma.user.findUnique({ where: { email } });
  if (ocupado) throw new Error("Já existe outra conta com este e-mail.");

  const de = user.email;

  /**
   * ⚠️ Três coisas além de gravar o endereço, e a falta delas era defeito em três frentes.
   *
   * 1. `emailVerifiedAt` volta a NULO. O endereço novo nunca foi confirmado por ninguém — foi
   *    digitado por quem atende. Sem zerar, o gate de contratação (que lê exatamente esse campo)
   *    liberaria a venda para um endereço que talvez esteja errado de novo, e o cliente pagaria
   *    para nunca receber aviso de acesso, segunda via nem recuperação de senha. É o problema que
   *    o gate existe para evitar, entrando pela porta do suporte.
   *
   * 2. O pedido de troca pendente do CLIENTE é cancelado. Sem isso, o conserto do suporte podia
   *    ser desfeito depois: o cliente tinha um pedido em curso para outro endereço, clicava no
   *    link mais tarde, e a conta ia para lá — sobrescrevendo a correção sem ninguém entender.
   *
   * 3. O status acompanha. Conta que estava ATIVA com e-mail confirmado volta a pendente de
   *    verificação, porque é o que ela passou a ser. Bloqueio e suspensão NÃO são tocados: são
   *    decisão de quem administra, e corrigir um e-mail não as revoga.
   */
  await prisma.user.update({
    where: { id: userId },
    data: {
      email,
      emailVerifiedAt: null,
      ...(user.status === "ATIVO" ? { status: "PENDENTE_VERIFICACAO" as const } : {}),
    },
  });
  const trocaCancelada = await cancelarTrocaDeEmailPendente(userId, "e-mail corrigido pelo atendimento");

  /**
   * E o link de confirmação sai para o endereço novo, senão a correção deixaria o cliente barrado
   * na contratação sem nada acontecendo — o suporte teria trocado um problema por outro.
   */
  const emissao = await emitirVerificacaoDeEmail({ id: userId, email, name: user.name });

  await logAudit({
    actorId: ator.id,
    actorRole: "ADMIN",
    action: "admin.user.email_corrected",
    entityType: "User",
    entityId: userId,
    metadata: {
      de,
      para: email,
      confirmacaoEnviada: emissao.enviado,
      trocaPendenteCancelada: trocaCancelada.cancelou ? trocaCancelada.endereco : null,
    },
  });

  return { de, para: email };
}

export interface CicloPendente {
  subscriptionId: string;
  organizacao: string;
  cliente: string;
  email: string;
  plano: string;
  periodo: string;
  cotaDoCiclo: number;
  saldoAtual: number;
  desdeQuando: Date | null;
}

/**
 * Assinaturas ativas cujo ciclo do mês corrente ainda NÃO recebeu créditos.
 *
 * Por que é necessário: nos planos ANUAIS o pagamento acontece uma vez, mas os
 * créditos são liberados por CICLO MENSAL. Sem esta lista, descobrir quem está
 * com o mês pendente era adivinhação — o cliente que pagou 12 meses ficava com
 * saldo zero e ninguém sabia — e o comentário anterior aqui afirmava que "o cron faz
 * isso sozinho", o que era FALSO: a manutenção diária não liberava ciclo nenhum, e
 * quem confiou nesse texto acreditou numa automação inexistente. Hoje ela libera, mas
 * SÓ o plano anual (ver src/lib/ciclo-anual.ts); o mensal depende do pagamento, e
 * liberar à mão no meio do ciclo dele adianta cota de graça.
 *
 * A detecção usa a mesma chave de idempotência da liberação
 * (`ciclo:<id>:<AAAA-MM>`), então o que esta lista mostra é exatamente o que a
 * ação "renovar ciclo" resolveria.
 */
export async function ciclosPendentes(referencia = new Date()): Promise<CicloPendente[]> {
  const ativas = await prisma.subscription.findMany({
    where: { status: "ATIVA" },
    include: {
      plan: { select: { name: true, period: true, monthlyAnalyses: true } },
      organization: { select: { name: true, owner: { select: { name: true, email: true } } } },
    },
  });

  /**
   * A pergunta é "houve liberação de cota neste mês?", não "existe lançamento com a
   * chave do mês?".
   *
   * A busca era pela chave `ciclo:<id>:<AAAA-MM>`. Quando a liberação por pagamento
   * passou a usar a identidade do PAGAMENTO na chave, essa busca deixaria de
   * encontrar qualquer coisa — e esta tela listaria TODO assinante como pendente,
   * convidando o administrador a liberar cota que já foi liberada. O predicado agora
   * é compartilhado com a rotina do plano anual, para os dois nunca discordarem.
   */
  const feitos = await assinaturasComCotaNoMes(ativas.map((s) => s.id), referencia);

  return ativas
    .filter((s) => !feitos.has(s.id))
    // Plano ilimitado (cota 0) não depende de liberação mensal.
    .filter((s) => s.plan.monthlyAnalyses > 0)
    .map((s) => ({
      subscriptionId: s.id,
      organizacao: s.organization.name,
      cliente: s.organization.owner?.name ?? "—",
      email: s.organization.owner?.email ?? "—",
      plano: s.plan.name,
      periodo: s.plan.period,
      cotaDoCiclo: s.plan.monthlyAnalyses,
      saldoAtual: Math.max(0, s.analysesQuota - s.analysesUsed) + Math.max(0, s.extraAnalyses),
      desdeQuando: s.currentPeriodEnd,
    }))
    .sort((a, b) => a.saldoAtual - b.saldoAtual);
}
