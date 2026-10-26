import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { logAudit, logSecurityEvent } from "./audit";
import { removeObject } from "./storage";
import { hmacSha256 } from "./crypto";
import { env } from "./env";

/**
 * Código estável daquela conta, para o rastro de segurança sobreviver sem identificar.
 *
 * ── O que isto conserta ───────────────────────────────────────────────────────
 * `SecurityEvent` guarda e-mail, IP e navegador, e NÃO tem vínculo com a conta — nenhuma
 * cascata a alcança. Então a "remoção definitiva" deixava o e-mail em claro em toda
 * tentativa de login falha, todo bloqueio por excesso de tentativas, toda falha de segundo
 * fator e no próprio registro da exclusão. Uma função que se chama exclusão preservava o
 * identificador dezenas de vezes, e nada na tela dizia isso.
 *
 * Apagar essas linhas seria pior de outro jeito: destruiria o histórico de segurança —
 * ataque de força bruta contra aquela conta deixa de existir, e a contagem que embasa
 * bloquear um IP vai com ele.
 *
 * Trocar o e-mail por um código estável preserva as duas coisas: o histórico continua
 * servindo (dá para ver "cinco tentativas falhas da MESMA conta", porque todas recebem o
 * mesmo código) e o identificador sai. É pseudonimização, não anonimização, e a diferença
 * importa: hash de e-mail é reversível por tentativa e erro, já que o conjunto de e-mails
 * possíveis é pequeno. Por isso a chave entra no hash — sem o segredo do servidor, o código
 * não volta a ser e-mail.
 */
function pseudonimoDaConta(email: string): string {
  return `conta-apagada:${hmacSha256(email.trim().toLowerCase(), env.authSecret).slice(0, 16)}`;
}

/**
 * Remoção definitiva de uma conta e de tudo que pende dela.
 *
 * ── Para que serve ────────────────────────────────────────────────────────────
 * Limpar conta de TESTE, cadastro duplicado ou registro criado por engano. Não
 * havia como fazer isso: o painel admin sabe bloquear e corrigir e-mail, mas não
 * apagar — e apagar à mão no Postgres é como se abrem buracos por acidente,
 * porque a ordem das chaves estrangeiras não é óbvia e o banco recusa no meio,
 * deixando a conta pela metade.
 *
 * ── O que sobrevive, e em que forma ───────────────────────────────────────────
 * Nem tudo pode desaparecer, e o que fica não fica identificando ninguém:
 *
 *  - **Dinheiro** — a linha do pagamento é DESLIGADA da assinatura, não apagada. Valor,
 *    forma e id da cobrança no provedor não têm dado pessoal, e a obrigação de guardar
 *    registro de pagamento não desaparece porque o cliente pediu para sair.
 *  - **Rastro de segurança** — as linhas de login falho, bloqueio e falha de segundo fator
 *    ficam, com o e-mail trocado pelo código da conta (ver `pseudonimoDaConta`). O
 *    histórico continua servindo; o identificador sai.
 *  - **Auditoria** — a linha fica e o vínculo com a pessoa é desfeito pelo próprio banco.
 *    A ÚNICA exceção deliberada é o registro `conta.apagada`, que preserva o e-mail: é a
 *    prestação de contas de qual conta foi apagada, e sem o e-mail não serviria a nada.
 *
 * O que vai embora inteiro: a conta, a organização, as análises, os documentos (inclusive
 * os arquivos no armazenamento), os créditos, as sessões, os consentimentos.
 *
 * Isto ainda NÃO é o fluxo do art. 18 da LGPD de ponta a ponta — falta a parte de atender
 * o pedido do titular com resposta formal e prazo. Mas o tratamento dos dados já é o de
 * anonimização onde a retenção é obrigatória, e não mais exclusão indiscriminada.
 */

export interface InventarioDaConta {
  userId: string;
  email: string;
  nome: string;
  perfil: string;
  estado: string;
  criadaEm: Date;
  organizacoes: { id: string; nome: string }[];
  assinaturas: { id: string; status: string }[];
  pagamentos: number;
  pagamentosAprovados: number;
  /** Quantias recebidas que ainda devem ser devolvidas a esta pessoa. */
  pagamentosADevolver: number;
  lancamentosDeCredito: number;
  analises: number;
  documentos: number;
  consentimentos: number;
  tokens: number;
  sessoes: number;
  notificacoes: number;
  /** Auditoria NÃO é apagada: a linha fica e o vínculo com a pessoa é desfeito. */
  auditoriaPreservada: number;
  /**
   * Linhas do registro de segurança com o e-mail desta conta — login falho, bloqueio,
   * falha de segundo fator. Não são apagadas: o e-mail delas é trocado por um código.
   * Aparece no inventário porque quem confirma a exclusão precisa saber o que sobrevive.
   */
  rastroDeSeguranca: number;
}

/** Levanta tudo que depende da conta, sem alterar nada. */
export async function inventarioDaConta(email: string): Promise<InventarioDaConta | null> {
  const alvo = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: alvo } });
  if (!user) return null;

  const orgs = await prisma.organization.findMany({
    where: { ownerId: user.id },
    select: { id: true, name: true },
  });
  const orgIds = orgs.map((o) => o.id);

  const subs = orgIds.length
    ? await prisma.subscription.findMany({
        where: { organizationId: { in: orgIds } },
        select: { id: true, status: true },
      })
    : [];
  const subIds = subs.map((s) => s.id);

  const [
    pagamentos,
    pagamentosAprovados,
    pagamentosADevolver,
    lancamentosDeCredito,
    analises,
    documentos,
    consentimentos,
    tokens,
    sessoes,
    notificacoes,
    auditoriaPreservada,
    rastroDeSeguranca,
  ] = await Promise.all([
    subIds.length ? prisma.payment.count({ where: { subscriptionId: { in: subIds } } }) : 0,
    subIds.length ? prisma.payment.count({ where: { subscriptionId: { in: subIds }, status: "APROVADO" } }) : 0,
    subIds.length ? prisma.payment.count({ where: { subscriptionId: { in: subIds }, status: "PENDENTE" } }) : 0,
    subIds.length ? prisma.creditLedger.count({ where: { subscriptionId: { in: subIds } } }) : 0,
    orgIds.length ? prisma.analysis.count({ where: { organizationId: { in: orgIds } } }) : 0,
    orgIds.length ? prisma.document.count({ where: { organizationId: { in: orgIds } } }) : 0,
    prisma.consent.count({ where: { userId: user.id } }),
    prisma.authToken.count({ where: { userId: user.id } }),
    prisma.session.count({ where: { userId: user.id } }),
    prisma.notification.count({ where: { userId: user.id } }),
    prisma.auditLog.count({ where: { actorId: user.id } }),
    prisma.securityEvent.count({ where: { email: user.email } }),
  ]);

  return {
    userId: user.id,
    email: user.email,
    nome: user.name,
    perfil: user.role,
    estado: user.status,
    criadaEm: user.createdAt,
    organizacoes: orgs.map((o) => ({ id: o.id, nome: o.name })),
    assinaturas: subs.map((s) => ({ id: s.id, status: s.status })),
    pagamentos,
    pagamentosAprovados,
    pagamentosADevolver,
    lancamentosDeCredito,
    analises,
    documentos,
    consentimentos,
    tokens,
    sessoes,
    notificacoes,
    auditoriaPreservada,
    rastroDeSeguranca,
  };
}

export type MotivoRecusa =
  | "nao_encontrada"
  | "e_admin"
  | "tem_pagamento_aprovado"
  /**
   * Há quantia PENDENTE — dinheiro que entrou e que NÓS devemos devolver a esta
   * pessoa. Apagar a conta não destrói mais o registro do valor (ele é desligado da
   * assinatura), mas destrói o que liga o valor ao PAGADOR: some o e-mail, some o
   * nome, e a devolução deixa de ter destinatário conhecido. Devolver primeiro, apagar
   * depois.
   */
  | "tem_pagamento_a_devolver";

export interface ResultadoExclusao {
  apagado: boolean;
  recusa?: MotivoRecusa;
  inventario?: InventarioDaConta;
  /** Arquivos efetivamente removidos do armazenamento privado. */
  arquivosRemovidos?: number;
  /**
   * Arquivos que o armazenamento recusou apagar. Não impedem a exclusão, mas
   * PRECISAM ser vistos: cada chave aqui é um documento de processo que continua
   * guardado sem nenhum registro no banco dizendo de quem era.
   */
  arquivosComFalha?: string[];
  /**
   * Linhas do registro de segurança que tiveram o e-mail trocado pelo código da conta.
   * Devolvido para quem operou a exclusão poder dizer o que sobreviveu, e em que forma.
   */
  rastroPseudonimizado?: number;
}

/**
 * Apaga a conta. Devolve a recusa em vez de lançar, para o chamador explicar o
 * motivo em português a quem está operando.
 */
export async function apagarConta(
  email: string,
  opcoes: { forcar?: boolean } = {},
): Promise<ResultadoExclusao> {
  const inventario = await inventarioDaConta(email);
  if (!inventario) return { apagado: false, recusa: "nao_encontrada" };

  // Guarda nº 1: nunca apagar administrador. É como o dono se trancaria fora do
  // próprio sistema com um comando.
  if (inventario.perfil === "ADMIN") {
    return { apagado: false, recusa: "e_admin", inventario };
  }

  // Guarda nº 2: pagamento aprovado é cliente real. Apagar destrói o registro
  // fiscal da venda, e um e-mail digitado errado aqui é irreversível.
  if (inventario.pagamentosAprovados > 0 && !opcoes.forcar) {
    return { apagado: false, recusa: "tem_pagamento_aprovado", inventario };
  }

  /**
   * Guarda nº 3: dinheiro a devolver. Vem ANTES da exclusão porque a exclusão apaga
   * quem é o credor — o registro do valor sobrevive, o nome e o e-mail do pagador não.
   * Não tem opção de forçar de propósito: devolver primeiro é sempre possível, e é o
   * que a Política promete.
   */
  if (inventario.pagamentosADevolver > 0) {
    return { apagado: false, recusa: "tem_pagamento_a_devolver", inventario };
  }

  // Rastro que sobrevive à exclusão. Vem ANTES do delete de propósito: se algo
  // falhar no meio, fica registrada a tentativa.
  await logSecurityEvent({
    type: "conta_apagada",
    email: inventario.email,
    metadata: {
      userId: inventario.userId,
      organizacoes: inventario.organizacoes.length,
      assinaturas: inventario.assinaturas.length,
      pagamentos: inventario.pagamentos,
      pagamentosAprovados: inventario.pagamentosAprovados,
      analises: inventario.analises,
      forcado: Boolean(opcoes.forcar),
    },
  });

  const orgIds = inventario.organizacoes.map((o) => o.id);

  /**
   * Pagamentos PRIMEIRO, e explicitamente.
   *
   * `Payment.subscriptionId` é opcional e a relação NÃO é cascata: apagar a assinatura
   * apenas põe a coluna em NULL, e a linha do pagamento sobrevive por conta própria. Aqui
   * isso é aproveitado de propósito — ver o bloco abaixo.
   *
   * Detalhe que custou um teste falso: contar `payment` por `subscriptionId` depois da
   * exclusão dá zero mesmo com as linhas todas lá, porque a coluna virou NULL. A verificação
   * tem de ser pelo id do pagamento.
   */
  if (orgIds.length) {
    const subs = await prisma.subscription.findMany({
      where: { organizationId: { in: orgIds } },
      select: { id: true },
    });
    const subIds = subs.map((s) => s.id);
    if (subIds.length) {
      /**
       * ⚠️ NENHUMA linha de pagamento é apagada. Todas são DESLIGADAS da assinatura.
       *
       * `Payment` guarda valor, forma de pagamento, data e o id da cobrança no provedor —
       * nenhum dado pessoal. Então ela sobrevive sem contrariar o que a exclusão promete
       * ao titular, e é o registro contábil que a obrigação fiscal manda guardar.
       *
       * Esse era o tratamento apenas das quantias PENDENTES, com a justificativa de que
       * "dinheiro a devolver não pode ser apagado". A justificativa é boa e vale IGUAL para
       * o pagamento APROVADO, que é receita realizada — e ele era apagado. Mesma razão
       * aplicada a um só dos dois estados.
       *
       * ── O que isso quebrava, e apareceu em produção ─────────────────────────────
       * A reconciliação pergunta ao Asaas o que ele considera pago e aplica o que não tem
       * registro aqui. Com a linha apagada, o pagamento de uma conta excluída voltava a ser
       * "descoberto" na varredura seguinte e abria um CASO: linha nova em "Dinheiro sem
       * destino" — o número que o painel chama de mais urgente, porque cada real ali é
       * alguém sem o que pagou — e alerta dizendo "quem pagou está sem serviço". Nada disso
       * era verdade: ninguém esperava acesso, nada havia a devolver. Falso caso no indicador
       * que menos pode ter falso, e repetido a cada exclusão.
       *
       * Desligada em vez de apagada, a cobrança continua reconhecível pelo `externalId`, a
       * varredura a trata como já vista, e a receita não desaparece dos livros.
       *
       * `raw` é limpo por precaução: nenhum código atual escreve nesse campo, mas ele foi
       * feito para guardar o payload cru do provedor, e payload cru pode conter nome,
       * e-mail ou documento. Preservar contabilidade não é desculpa para preservar dado
       * pessoal por descuido.
       */
      await prisma.payment.updateMany({
        where: { subscriptionId: { in: subIds } },
        // `Prisma.DbNull` grava NULL na coluna; `null` puro não é aceito em campo Json.
        data: { subscriptionId: null, raw: Prisma.DbNull },
      });
    }
  }

  /**
   * ARQUIVOS ANTES DO BANCO — e esta ordem é a única que funciona.
   *
   * A cascata apaga a linha `Document`, e com ela a `storageKey`. Sem os arquivos
   * removidos primeiro, os PDFs continuavam no armazenamento privado sem nenhum
   * registro que dissesse a quem pertenciam: exclusão de conta que deixava para
   * trás justamente o dado mais sensível do sistema — cópia integral de execução
   * fiscal, com dados de terceiros e sob sigilo profissional. Para a LGPD isso não
   * é eliminação (art. 16 e art. 18, VI); é perda de rastreio.
   *
   * Falha em um objeto não aborta a exclusão. Interromper aqui deixaria a conta
   * meio apagada, estado pior que o inicial: o certo é remover o que der, contar o
   * que sobrou e devolver essa informação a quem operou a exclusão.
   */
  let arquivosRemovidos = 0;
  const arquivosComFalha: string[] = [];
  if (orgIds.length) {
    const docs = await prisma.document.findMany({
      where: { organizationId: { in: orgIds } },
      select: { storageKey: true },
    });
    for (const doc of docs) {
      if (!doc.storageKey) continue;
      try {
        await removeObject(doc.storageKey);
        arquivosRemovidos++;
      } catch (err) {
        arquivosComFalha.push(doc.storageKey);
        console.error(`[apagar-conta] arquivo não removido (${doc.storageKey}):`, (err as Error).message);
      }
    }
  }

  /**
   * Depois a organização, e só então a pessoa.
   *
   * `Analysis.ownerId` é obrigatório e aponta para User, então apagar a pessoa
   * antes é RECUSADO pelo banco enquanto existir análise dela. Apagar a
   * organização derruba em cascata Subscription (e com ela CreditLedger e
   * ConsumptionRecord), Analysis (e com ela páginas, revisão, relatórios) e
   * Document. Só depois a pessoa sai limpa, levando em cascata Session,
   * AuthToken, Notification e Consent.
   */
  if (orgIds.length) {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  }
  await prisma.user.delete({ where: { id: inventario.userId } });

  /**
   * ⚠️ A PRESTAÇÃO DE CONTAS sai daqui, e não da rota do painel.
   *
   * O painel já grava `admin.user.deleted` com quem apagou. Mas esta função também é
   * chamada por `scripts/apagar-conta.ts`, pela linha de comando, onde aquele registro não
   * existe — e é justamente ali que a exclusão é feita às pressas. Sem este registro, o
   * caminho do terminal apagaria uma conta sem deixar em lugar nenhum QUAL conta era, e a
   * pergunta "apaguei a conta errada?" ficaria sem resposta possível.
   *
   * Este é o único lugar onde o e-mail de quem foi apagado é preservado de propósito, e é o
   * lugar certo: prestação de contas administrativa, uma linha por exclusão. Sem o e-mail
   * ela não serviria para nada — diferente do registro de SEGURANÇA, que continua útil sem
   * identificar ninguém, e é por isso que lá o e-mail sai.
   */
  await logAudit({
    action: "conta.apagada",
    entityType: "User",
    entityId: inventario.userId,
    metadata: {
      email: inventario.email,
      /**
       * O código vai junto: é o que permite, partindo desta linha, encontrar no registro de
       * segurança o rastro daquela conta. Sem ele a pseudonimização seria mão única e
       * ninguém conseguiria investigar um incidente depois da exclusão.
       */
      pseudonimo: pseudonimoDaConta(inventario.email),
      organizacoes: inventario.organizacoes.length,
      assinaturas: inventario.assinaturas.length,
      pagamentosPreservados: inventario.pagamentos,
      analises: inventario.analises,
      forcado: Boolean(opcoes.forcar),
    },
  });

  /**
   * ⚠️ A pseudonimização é a ÚLTIMA coisa, e a ordem é o desenho.
   *
   * Se qualquer passo acima falhar, o e-mail continua no rastro — e é exatamente quando
   * alguém precisa dele, para achar e terminar à mão a conta que ficou pela metade. O
   * identificador só desaparece quando a exclusão inteira deu certo.
   */
  const rastro = await prisma.securityEvent.updateMany({
    where: { email: inventario.email },
    data: { email: pseudonimoDaConta(inventario.email) },
  });

  return {
    apagado: true,
    inventario,
    arquivosRemovidos,
    arquivosComFalha,
    rastroPseudonimizado: rastro.count,
  };
}
