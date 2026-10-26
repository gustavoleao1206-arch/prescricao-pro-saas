import { prisma } from "./db";
import { logAudit, logSecurityEvent } from "./audit";
import { sendReactivated } from "./subscription-emails";
import type { Subscription } from "@prisma/client";

/**
 * Revisão administrativa de estorno e contestação de cobrança.
 *
 * ── O problema que isto resolve ───────────────────────────────────────────────
 * Recebido um estorno ou um chargeback, o sistema marca a assinatura ESTORNADA e o
 * login passa a ser recusado: o cliente não entra nem para consultar o histórico. A
 * Política de Cancelamento e os Termos prometem que essa revisão termina em prazo
 * certo e que, **esgotado o prazo sem decisão comunicada, o acesso é restabelecido**.
 * A cláusula existe porque suspensão sem termo final, cujo fim depende só da
 * diligência do fornecedor, é vantagem exagerada (art. 51, IV, do CDC).
 *
 * Só que a promessa não tinha mecanismo. Nada media o prazo, e a única ferramenta do
 * painel — "Liberar" — grava ATIVA e ESTENDE o período por um ciclo inteiro: usar
 * isso para cumprir a cláusula presentearia o cliente com um mês de graça e falsearia
 * a data da próxima cobrança. Este módulo é o mecanismo que faltava.
 *
 * ── Duas formas de restabelecer, e a diferença importa ────────────────────────
 *  - "decisao": a revisão concluiu a favor do cliente, ou o pagamento foi
 *    regularizado. Restabelece o acesso E desbloqueia os créditos, que é o que a
 *    Política promete nessa hipótese.
 *  - "prazo": o prazo venceu sem decisão. Restabelece o ACESSO, porque o bloqueio
 *    não pode ser indefinido, e mantém os créditos bloqueados — eles foram
 *    comprados pelo pagamento que voltou para o cliente, e desbloqueá-los sem
 *    regularização entregaria o que não foi pago. É a leitura literal da Política,
 *    que amarra o desbloqueio à regularização.
 *
 * Nenhuma das duas mexe em `currentPeriodEnd`: o cliente recupera o período que
 * comprou, nem um dia mais.
 */

/**
 * Prazo da revisão, em DIAS ÚTEIS, contados do recebimento do evento.
 *
 * Fonte única: a Política de Cancelamento e Retenção importa esta constante em vez
 * de escrever o número. Mudar aqui muda o texto publicado e o prazo aplicado.
 */
export const PRAZO_REVISAO_DIAS_UTEIS = 10;

export const MOTIVO_RESTABELECIMENTO_PRAZO = "Prazo da revisão esgotado sem decisão";
export const MOTIVO_RESTABELECIMENTO_DECISAO = "Revisão concluída a favor do assinante";

/**
 * Soma dias ÚTEIS a uma data, contando de segunda a sexta.
 *
 * Feriado NÃO é considerado, e isso é deliberado: sem tabela de feriados nacionais e
 * municipais, ignorá-los faz o prazo vencer MAIS CEDO — o acesso volta antes. O erro
 * cai a favor do cliente, que é o único lado seguro de errar aqui. Tabela de feriados
 * só valeria a pena se o prazo fosse usado para cobrar alguém.
 */
export function somarDiasUteis(inicio: Date, dias: number): Date {
  const d = new Date(inicio.getTime());
  let restantes = Math.max(0, Math.trunc(dias));
  while (restantes > 0) {
    d.setDate(d.getDate() + 1);
    const semana = d.getDay();
    // 0 = domingo, 6 = sábado.
    if (semana !== 0 && semana !== 6) restantes--;
  }
  return d;
}

/**
 * Quando a revisão desta assinatura vence. Nulo se ela não está em revisão.
 *
 * ── Só ESTORNADA, e isto é o escopo da promessa ───────────────────────────────
 * O prazo aqui é o da Política de Cancelamento §6: "concluída em até N dias úteis do
 * recebimento DO EVENTO", contado da contestação de cobrança, e existe porque bloqueio
 * sem termo final seria vantagem exagerada (art. 51, IV, do CDC).
 *
 * SUSPENSA entrava nesta conta, e isso produzia uma promessa falsa no painel: a linha da
 * assinatura mostrava um prazo de revisão e, vencido, dizia "o acesso é restabelecido
 * automaticamente". Para SUSPENSA nunca foi verdade — a varredura de manutenção sempre
 * alcançou apenas ESTORNADA, de propósito. Quem lia o painel era levado a esperar um
 * restabelecimento que não vinha, e a errar na direção pior: acreditar que um prazo o
 * obrigava quando ele não obrigava.
 *
 * Suspensão administrativa tem regime próprio, na Política de Uso Aceitável §10: avisos
 * prévios com prazos próprios, e reversão "cessada a causa" — por decisão, não por
 * decurso. Medir as duas com a mesma régua era erro de categoria.
 */
export function prazoDaRevisao(sub: Pick<Subscription, "status" | "canceledAt" | "suspendedAt" | "revisaoProrrogadaEm">): Date | null {
  if (sub.status !== "ESTORNADA") return null;
  const inicio = sub.canceledAt ?? sub.suspendedAt;
  if (!inicio) return null;
  // A prorrogação é por igual período, uma única vez (Política de Cancelamento).
  const dias = sub.revisaoProrrogadaEm ? PRAZO_REVISAO_DIAS_UTEIS * 2 : PRAZO_REVISAO_DIAS_UTEIS;
  return somarDiasUteis(inicio, dias);
}

export interface ResultadoRestabelecimento {
  restabelecida: boolean;
  recusa?: "nao_encontrada" | "estado_nao_permite";
  /** Créditos devolvidos ao saldo, quando o motivo foi decisão favorável. */
  creditosDesbloqueados?: number;
  avisoEnviado?: boolean;
}

/**
 * Devolve ao saldo os créditos que o estorno bloqueou.
 *
 * O bloqueio é uma entrada NEGATIVA no extrato (ver `handleEstorno`), que zerou o
 * saldo do ciclo e o saldo avulso de uma vez. O desbloqueio lança a entrada oposta e
 * recompõe os dois campos, mantendo o extrato legível: quem ler vê o bloqueio e vê a
 * devolução, com o motivo de cada um.
 *
 * Idempotente pela chave: chamar duas vezes não credita duas vezes.
 */
async function desbloquearCreditos(sub: Subscription, actorId?: string): Promise<number> {
  /**
   * Só o bloqueio DESTA revisão é desfeito.
   *
   * A busca era pelo bloqueio mais recente da assinatura, sem olhar a data. Bloqueio de
   * um estorno ANTIGO — cuja revisão terminou contra o cliente, e cujos créditos foram
   * legitimamente perdidos — podia ser resgatado por uma decisão favorável meses
   * depois, devolvendo saldo que ninguém decidiu devolver.
   *
   * A revisão corrente começa no evento que a abriu: `canceledAt` no estorno,
   * `suspendedAt` na suspensão. Bloqueio anterior a isso pertence a outra história.
   */
  const inicioDaRevisao = sub.canceledAt ?? sub.suspendedAt;
  const bloqueio = await prisma.creditLedger.findFirst({
    where: {
      subscriptionId: sub.id,
      quantity: { lt: 0 },
      description: { contains: "bloqueados por estorno" },
      ...(inicioDaRevisao ? { createdAt: { gte: inicioDaRevisao } } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  if (!bloqueio) return 0;

  const quantidade = Math.abs(bloqueio.quantity);
  const chave = `desbloqueio:${bloqueio.id}`;
  if (await prisma.creditLedger.findUnique({ where: { idempotencyKey: chave } })) return 0;

  /**
   * O saldo volta como AVULSO, não como cota do ciclo.
   *
   * O bloqueio somou as duas bolsas numa entrada só, então não há como separar
   * quanto era de cada uma. Devolver tudo como avulso é o recorte que não inventa
   * cota: crédito avulso é do cliente até vencer, enquanto recompor a cota mensal
   * poderia dar mais do que ele tinha se o ciclo já tivesse virado.
   */
  await prisma.$transaction([
    prisma.creditLedger.create({
      data: {
        subscriptionId: sub.id,
        kind: "AJUSTE_ADMIN",
        bucket: "ADICIONAL",
        quantity: quantidade,
        balanceBefore: 0,
        balanceAfter: quantidade,
        description: "Créditos desbloqueados após revisão do estorno",
        reason: MOTIVO_RESTABELECIMENTO_DECISAO,
        actorId: actorId ?? null,
        idempotencyKey: chave,
      },
    }),
    prisma.subscription.update({
      where: { id: sub.id },
      data: { extraAnalyses: { increment: quantidade } },
    }),
  ]);
  return quantidade;
}

/**
 * Restabelece o acesso de uma assinatura em revisão, SEM estender o período pago.
 *
 * `motivo: "decisao"` desbloqueia os créditos; `"prazo"` não — ver o cabeçalho.
 */
export async function restabelecerAcesso(
  subscriptionId: string,
  opcoes: { motivo: "decisao" | "prazo"; actorId?: string; observacao?: string },
): Promise<ResultadoRestabelecimento> {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) return { restabelecida: false, recusa: "nao_encontrada" };
  if (sub.status !== "ESTORNADA" && sub.status !== "SUSPENSA") {
    return { restabelecida: false, recusa: "estado_nao_permite" };
  }

  const estadoAnterior = sub.status;
  const motivoAnterior = sub.canceledReason;

  const creditosDesbloqueados =
    opcoes.motivo === "decisao" ? await desbloquearCreditos(sub, opcoes.actorId) : 0;

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status: "ATIVA",
      reactivatedAt: new Date(),
      suspendedAt: null,
      canceledAt: null,
      canceledReason: null,
      graceUntil: null,
      revisaoProrrogadaEm: null,
      /**
       * `currentPeriodEnd` NÃO é tocado, e é este o ponto do módulo. A ação
       * "Liberar" do painel soma um ciclo inteiro — apropriado para concessão
       * comercial, errado aqui: o cliente recupera exatamente o período que pagou, e
       * a data da próxima cobrança continua verdadeira.
       */
    },
  });

  const dono = await prisma.user.findFirst({
    where: { organizationId: sub.organizationId },
    select: { id: true, email: true, name: true },
  });
  let avisoEnviado = false;
  if (dono) {
    /**
     * O cliente TEM de ser avisado: ele saiu de um estado em que não conseguia nem
     * entrar. Falha no e-mail não desfaz o restabelecimento — o acesso já está de
     * volta, e um erro aqui só o deixaria bloqueado de novo.
     */
    try {
      await sendReactivated({ email: dono.email, name: dono.name });
      avisoEnviado = true;
    } catch (err) {
      console.error(`[revisao] acesso restabelecido, aviso NÃO enviado (${dono.email}):`, (err as Error).message);
    }
  }

  await logAudit({
    actorId: opcoes.actorId,
    actorRole: opcoes.actorId ? "ADMIN" : undefined,
    action: opcoes.motivo === "prazo" ? "subscription.restabelecida_por_prazo" : "subscription.restabelecida_por_decisao",
    entityType: "Subscription",
    entityId: sub.id,
    metadata: {
      de: estadoAnterior,
      motivoAnterior,
      creditosDesbloqueados,
      avisoEnviado,
      observacao: opcoes.observacao ?? null,
    },
  });

  return { restabelecida: true, creditosDesbloqueados, avisoEnviado };
}

/** Registra a prorrogação da revisão, uma única vez, por igual período. */
export async function prorrogarRevisao(
  subscriptionId: string,
  opcoes: { actorId: string; observacao?: string },
): Promise<{ prorrogada: boolean; recusa?: "nao_encontrada" | "estado_nao_permite" | "ja_prorrogada"; novoPrazo?: Date }> {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) return { prorrogada: false, recusa: "nao_encontrada" };
  /**
   * Só ESTORNADA: prorrogar é estender um prazo que produz efeito automático, e esse
   * efeito só existe na revisão de contestação. Em SUSPENSA não havia o que prorrogar — a
   * ação apenas registrava uma prorrogação sem consequência nenhuma.
   */
  if (sub.status !== "ESTORNADA") {
    return { prorrogada: false, recusa: "estado_nao_permite" };
  }
  // Uma única vez: é o que a Política publica, e prorrogar sem limite recriaria a
  // suspensão indefinida que a cláusula do prazo existe para impedir.
  if (sub.revisaoProrrogadaEm) return { prorrogada: false, recusa: "ja_prorrogada" };

  const atualizada = await prisma.subscription.update({
    where: { id: sub.id },
    data: { revisaoProrrogadaEm: new Date() },
  });
  await logAudit({
    actorId: opcoes.actorId,
    actorRole: "ADMIN",
    action: "subscription.revisao_prorrogada",
    entityType: "Subscription",
    entityId: sub.id,
    metadata: { observacao: opcoes.observacao ?? null },
  });
  return { prorrogada: true, novoPrazo: prazoDaRevisao(atualizada) ?? undefined };
}

/**
 * Manutenção diária: restabelece o acesso das revisões que venceram sem decisão.
 *
 * Alcança apenas `ESTORNADA`, e de propósito. `SUSPENSA` é medida administrativa — uso
 * aceitável, pendência em apuração —, e restabelecer sozinho seria devolver o acesso a
 * quem foi sancionado só porque o prazo passou. Por decisão do dono do negócio, suspensão
 * por abuso NÃO volta pelo decurso: quem devolve o acesso é o administrador, pelo painel.
 * O prazo publicado (Política de Cancelamento §6) é da contestação de cobrança, e é essa
 * a única hipótese que esta varredura executa — ver `prazoDaRevisao`.
 *
 * Idempotente: a assinatura restabelecida sai do filtro no mesmo instante.
 */
export async function restabelecerRevisoesSemDecisao(
  agora: Date = new Date(),
): Promise<{ restabelecidas: number; ids: string[] }> {
  const emRevisao = await prisma.subscription.findMany({
    where: { status: "ESTORNADA", canceledAt: { not: null } },
    select: { id: true, status: true, canceledAt: true, suspendedAt: true, revisaoProrrogadaEm: true },
  });

  const vencidas = emRevisao.filter((s) => {
    const prazo = prazoDaRevisao(s as Parameters<typeof prazoDaRevisao>[0]);
    return prazo !== null && prazo < agora;
  });

  const ids: string[] = [];
  for (const s of vencidas) {
    const r = await restabelecerAcesso(s.id, { motivo: "prazo" });
    if (!r.restabelecida) continue;
    ids.push(s.id);
    /**
     * Evento de segurança, não só auditoria: o acesso voltou porque NINGUÉM decidiu
     * no prazo. É falha de operação, e precisa aparecer onde as falhas aparecem —
     * senão o restabelecimento automático vira rotina silenciosa de perdão de
     * estorno.
     */
    await logSecurityEvent({
      type: "revisao_de_estorno_vencida_sem_decisao",
      metadata: { subscriptionId: s.id, desde: s.canceledAt?.toISOString() ?? null },
    });
  }

  return { restabelecidas: ids.length, ids };
}
