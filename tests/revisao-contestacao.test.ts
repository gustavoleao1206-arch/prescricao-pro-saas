import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Revisão de estorno: prazo, restabelecimento e o que NÃO deve acontecer.
 *
 * A cláusula que este módulo cumpre é a que impede a suspensão indefinida: recebido
 * um estorno, o login é recusado, e os Termos prometem que, esgotado o prazo da
 * revisão sem decisão, o acesso volta. Antes não havia mecanismo — a única ação do
 * painel somava um ciclo inteiro ao período pago.
 *
 * Três coisas são travadas aqui, e cada uma custa dinheiro se sair errado:
 *  1. restabelecer NÃO estende `currentPeriodEnd` (era o defeito do botão antigo);
 *  2. o restabelecimento por PRAZO não devolve crédito — ele foi comprado pelo
 *     pagamento que voltou ao cliente; por DECISÃO, devolve;
 *  3. a rotina automática alcança só ESTORNADA. Quem está SUSPENSA por falta de
 *     pagamento não recupera acesso por decurso de prazo.
 */

process.env.ASAAS_API_KEY = "chave-de-teste-nao-vai-para-a-rede";

const {
  PRAZO_REVISAO_DIAS_UTEIS,
  somarDiasUteis,
  prazoDaRevisao,
  restabelecerAcesso,
  prorrogarRevisao,
  restabelecerRevisoesSemDecisao,
} = await import("../src/lib/revisao-contestacao");
const { subscriptionGrantsAccess } = await import("../src/lib/consumption");

const prisma = new PrismaClient();
const PREFIXO = "test-revisao";

let planoId = "";
let orgId = "";
let userId = "";

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orgs = await prisma.organization.findMany({
    where: { OR: [{ name: { startsWith: PREFIXO } }, { ownerId: { in: ids } }] },
    select: { id: true },
  });
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.securityEvent.deleteMany({ where: { type: "revisao_de_estorno_vencida_sem_decisao" } });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

/** Assinatura em revisão, com o evento recebido há `diasAtras` dias corridos. */
async function emRevisao(opcoes: {
  status: "ESTORNADA" | "SUSPENSA";
  diasAtras: number;
  cota?: number;
  bloqueados?: number;
  prorrogada?: boolean;
}) {
  const inicio = new Date(Date.now() - opcoes.diasAtras * 86_400_000);
  const cota = opcoes.cota ?? 0;
  const sub = await prisma.subscription.create({
    data: {
      organizationId: orgId,
      planId: planoId,
      status: opcoes.status,
      provider: "ASAAS",
      amountCents: 4990,
      analysesQuota: cota,
      // O bloqueio do estorno zera o saldo: usado = cota, avulso = 0.
      analysesUsed: cota,
      extraAnalyses: 0,
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      nextRenewalAt: new Date(Date.now() + 20 * 86_400_000),
      canceledAt: opcoes.status === "ESTORNADA" ? inicio : null,
      suspendedAt: opcoes.status === "SUSPENSA" ? inicio : null,
      canceledReason: opcoes.status === "ESTORNADA" ? "Estorno (PAYMENT_REFUNDED)" : null,
      revisaoProrrogadaEm: opcoes.prorrogada ? new Date() : null,
    },
  });

  if (opcoes.bloqueados) {
    await prisma.creditLedger.create({
      data: {
        subscriptionId: sub.id,
        kind: "AJUSTE_ADMIN",
        bucket: null,
        quantity: -opcoes.bloqueados,
        balanceBefore: opcoes.bloqueados,
        balanceAfter: 0,
        description: "Créditos bloqueados por estorno do pagamento",
        reason: "Estorno (PAYMENT_REFUNDED), caso encaminhado para revisão administrativa",
        idempotencyKey: `estorno-asaas:${sub.id}`,
      },
    });
  }
  return sub;
}

beforeAll(async () => {
  await limpar();
  const plano = await prisma.plan.create({
    data: { slug: `${PREFIXO}-plano`, name: "Plano Revisão", priceCents: 4990, period: "MENSAL", monthlyAnalyses: 0, maxUsers: 1 },
  });
  planoId = plano.id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await limpar();
  await prisma.$disconnect();
});

beforeEach(async () => {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orgs = await prisma.organization.findMany({ where: { ownerId: { in: ids } }, select: { id: true } });
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });

  const user = await prisma.user.create({
    data: { email: `${PREFIXO}-cliente@exemplo.local`, name: "Cliente Revisão", role: "CLIENTE", status: "ATIVO" },
  });
  userId = user.id;
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org`, ownerId: user.id } });
  orgId = org.id;
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id, orgRole: "OWNER" } });
});

describe("contagem em dias úteis", () => {
  it("pula sábado e domingo", () => {
    // 2026-08-03 é uma segunda-feira.
    const segunda = new Date("2026-08-03T12:00:00.000Z");
    // +5 dias úteis = segunda seguinte, 10/08.
    expect(somarDiasUteis(segunda, 5).toISOString().slice(0, 10)).toBe("2026-08-10");
    // +1 a partir de sexta cai na segunda.
    const sexta = new Date("2026-08-07T12:00:00.000Z");
    expect(somarDiasUteis(sexta, 1).toISOString().slice(0, 10)).toBe("2026-08-10");
  });

  it("dez dias úteis são quatorze corridos quando começam na segunda", () => {
    const segunda = new Date("2026-08-03T12:00:00.000Z");
    expect(somarDiasUteis(segunda, PRAZO_REVISAO_DIAS_UTEIS).toISOString().slice(0, 10)).toBe("2026-08-17");
  });

  it("não anda com zero", () => {
    const d = new Date("2026-08-03T12:00:00.000Z");
    expect(somarDiasUteis(d, 0).getTime()).toBe(d.getTime());
  });
});

describe("prazo da revisão", () => {
  it("conta do recebimento do evento e dobra quando prorrogada", async () => {
    const sub = await emRevisao({ status: "ESTORNADA", diasAtras: 0 });
    const simples = prazoDaRevisao(sub)!;
    const prorrogada = prazoDaRevisao({ ...sub, revisaoProrrogadaEm: new Date() })!;
    expect(prorrogada.getTime()).toBeGreaterThan(simples.getTime());
  });

  it("é nulo para assinatura que não está em revisão", async () => {
    const sub = await prisma.subscription.create({
      data: { organizationId: orgId, planId: planoId, status: "ATIVA", provider: "ASAAS", amountCents: 4990, analysesQuota: 0 },
    });
    expect(prazoDaRevisao(sub)).toBeNull();
  });

  /**
   * ── O prazo é da CONTESTAÇÃO, não da sanção ──────────────────────────────────
   *
   * SUSPENSA entrava nesta conta, e o painel exibia um prazo de revisão para suspensão
   * administrativa — dizendo, vencido, que "o acesso é restabelecido automaticamente".
   * Nunca foi verdade: a varredura sempre alcançou apenas ESTORNADA. Quem lia o painel era
   * levado a acreditar que um prazo o obrigava quando ele não obrigava.
   *
   * Suspensão por abuso não volta por decurso — decisão do dono do negócio —, e tem regime
   * próprio na Política de Uso Aceitável §10: reversão "cessada a causa", por decisão.
   */
  it("é nulo em suspensão administrativa: aquele prazo não se aplica à sanção", async () => {
    const sub = await emRevisao({ status: "SUSPENSA", diasAtras: 60 });
    expect(prazoDaRevisao(sub)).toBeNull();
  });

  it("prorrogar não existe em suspensão administrativa — não há prazo a estender", async () => {
    const sub = await emRevisao({ status: "SUSPENSA", diasAtras: 1 });

    const r = await prorrogarRevisao(sub.id, { actorId: userId });

    expect(r.prorrogada).toBe(false);
    expect(r.recusa).toBe("estado_nao_permite");
  });

  it("restabelecer À MÃO continua valendo para a suspensão — é a única saída", async () => {
    // A decisão do dono foi "não volta pelo prazo", não "não volta nunca".
    const sub = await emRevisao({ status: "SUSPENSA", diasAtras: 30 });

    const r = await restabelecerAcesso(sub.id, { motivo: "decisao", actorId: userId });

    expect(r.restabelecida).toBe(true);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("ATIVA");
  });
});

describe("restabelecer o acesso", () => {
  it("NÃO estende o período pago — é a diferença em relação a 'Liberar'", async () => {
    const sub = await emRevisao({ status: "ESTORNADA", diasAtras: 1 });
    const fimAntes = sub.currentPeriodEnd!.getTime();

    const r = await restabelecerAcesso(sub.id, { motivo: "decisao", actorId: userId });
    expect(r.restabelecida).toBe(true);

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("ATIVA");
    /**
     * O ponto do teste. A ação "reativar" do painel soma um ciclo inteiro; usá-la
     * para desfazer bloqueio de estorno daria ao cliente um mês de graça e faria a
     * data da próxima cobrança mentir.
     */
    expect(depois.currentPeriodEnd!.getTime()).toBe(fimAntes);
    // E o acesso volta de fato, não só o rótulo do status.
    expect(subscriptionGrantsAccess(depois)).toBe(true);
    // O estado de bloqueio é limpo, senão a tela seguiria mostrando "Motivo: Estorno".
    expect(depois.canceledAt).toBeNull();
    expect(depois.canceledReason).toBeNull();
    expect(depois.revisaoProrrogadaEm).toBeNull();
  });

  it("por DECISÃO devolve os créditos bloqueados, uma única vez", async () => {
    const sub = await emRevisao({ status: "ESTORNADA", diasAtras: 1, cota: 6, bloqueados: 4 });

    const r = await restabelecerAcesso(sub.id, { motivo: "decisao", actorId: userId });
    expect(r.creditosDesbloqueados).toBe(4);

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.extraAnalyses).toBe(4);
    // O extrato precisa mostrar a devolução ao lado do bloqueio.
    const entrada = await prisma.creditLedger.findFirst({
      where: { subscriptionId: sub.id, quantity: { gt: 0 } },
    });
    expect(entrada?.description).toContain("desbloqueados");

    // Repetir não credita de novo (idempotência pela chave).
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: "ESTORNADA" } });
    const outra = await restabelecerAcesso(sub.id, { motivo: "decisao", actorId: userId });
    expect(outra.creditosDesbloqueados).toBe(0);
    const final = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(final.extraAnalyses).toBe(4);
  });

  it("por PRAZO devolve o acesso mas NÃO os créditos", async () => {
    const sub = await emRevisao({ status: "ESTORNADA", diasAtras: 30, cota: 6, bloqueados: 4 });

    const r = await restabelecerAcesso(sub.id, { motivo: "prazo" });
    expect(r.restabelecida).toBe(true);
    expect(r.creditosDesbloqueados).toBe(0);

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("ATIVA");
    /**
     * O crédito foi comprado pelo pagamento que VOLTOU para o cliente. Devolver o
     * saldo sem regularização entregaria o que não foi pago — e a Política amarra o
     * desbloqueio à regularização, não ao decurso do prazo.
     */
    expect(depois.extraAnalyses).toBe(0);
  });

  it("recusa assinatura que não está em revisão, em vez de estourar", async () => {
    const sub = await prisma.subscription.create({
      data: { organizationId: orgId, planId: planoId, status: "ATIVA", provider: "ASAAS", amountCents: 4990, analysesQuota: 0 },
    });
    const r = await restabelecerAcesso(sub.id, { motivo: "decisao", actorId: userId });
    expect(r.restabelecida).toBe(false);
    expect(r.recusa).toBe("estado_nao_permite");
  });

  it("registra na auditoria de que forma o acesso voltou", async () => {
    const sub = await emRevisao({ status: "ESTORNADA", diasAtras: 30 });
    await restabelecerAcesso(sub.id, { motivo: "prazo" });

    const log = await prisma.auditLog.findFirst({
      where: { entityId: sub.id, action: "subscription.restabelecida_por_prazo" },
    });
    expect(log).toBeTruthy();
    expect((log!.metadata as Record<string, unknown>).de).toBe("ESTORNADA");
  });
});

describe("prorrogação da revisão", () => {
  it("vale uma única vez", async () => {
    const sub = await emRevisao({ status: "ESTORNADA", diasAtras: 2 });

    const primeira = await prorrogarRevisao(sub.id, { actorId: userId });
    expect(primeira.prorrogada).toBe(true);
    expect(primeira.novoPrazo).toBeInstanceOf(Date);

    // Prorrogar sem limite recriaria a suspensão indefinida que o prazo existe para
    // impedir (art. 51, IV, do CDC).
    const segunda = await prorrogarRevisao(sub.id, { actorId: userId });
    expect(segunda.prorrogada).toBe(false);
    expect(segunda.recusa).toBe("ja_prorrogada");
  });
});

describe("manutenção diária", () => {
  it("restabelece a revisão vencida sem decisão", async () => {
    // 30 dias corridos passam de 10 dias úteis em qualquer calendário.
    const sub = await emRevisao({ status: "ESTORNADA", diasAtras: 30 });

    const r = await restabelecerRevisoesSemDecisao();
    expect(r.ids).toContain(sub.id);

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("ATIVA");

    // O restabelecimento automático é falha de operação e tem de aparecer como tal.
    const evento = await prisma.securityEvent.findFirst({
      where: { type: "revisao_de_estorno_vencida_sem_decisao" },
      orderBy: { createdAt: "desc" },
    });
    expect(evento).toBeTruthy();
  });

  it("não toca em revisão dentro do prazo", async () => {
    const sub = await emRevisao({ status: "ESTORNADA", diasAtras: 2 });
    const r = await restabelecerRevisoesSemDecisao();
    expect(r.ids).not.toContain(sub.id);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("ESTORNADA");
  });

  it("respeita a prorrogação: o prazo dobra", async () => {
    // 20 dias corridos vencem 10 dias úteis, mas não 20.
    const sub = await emRevisao({ status: "ESTORNADA", diasAtras: 20, prorrogada: true });
    const r = await restabelecerRevisoesSemDecisao();
    expect(r.ids).not.toContain(sub.id);
  });

  it("NÃO restabelece quem está SUSPENSA — inadimplência não vira acesso por decurso", async () => {
    /**
     * Este é o teste que impede o pior erro possível aqui: aplicar a cláusula do
     * estorno a quem simplesmente não pagou. SUSPENSA também é usada para
     * inadimplência persistente e para medida de uso aceitável.
     */
    const sub = await emRevisao({ status: "SUSPENSA", diasAtras: 60 });
    const r = await restabelecerRevisoesSemDecisao();
    expect(r.ids).not.toContain(sub.id);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("SUSPENSA");
  });

  it("rodar duas vezes no mesmo dia não faz nada na segunda", async () => {
    await emRevisao({ status: "ESTORNADA", diasAtras: 30 });
    expect((await restabelecerRevisoesSemDecisao()).restabelecidas).toBe(1);
    expect((await restabelecerRevisoesSemDecisao()).restabelecidas).toBe(0);
  });
});
