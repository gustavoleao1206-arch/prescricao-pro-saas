import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Downgrade: o plano muda no fim do ciclo, e a COBRANÇA tem de mudar junto.
 *
 * ── O defeito que estes testes travam ─────────────────────────────────────────
 * O agendamento do downgrade gravava dois campos no nosso banco e mais nada. A
 * recorrência do Asaas continuava no valor e na periodicidade do plano ANTIGO, para
 * sempre. Numa troca de faixa isso vazava a diferença todo mês. Na troca de ANUAL para
 * MENSAL o resultado era grotesco: na renovação o Asaas cobrava os R$ 419,00 do anual, o
 * sistema aplicava o plano mensal e registrava 30 DIAS de acesso. O cliente pagava um ano
 * e ficava sem serviço em um mês — e a cobrança seguinte só voltaria doze meses depois,
 * quando ele já estava fora do ar há onze.
 *
 * Três defesas, e cada uma é testada aqui:
 *  1. a recorrência é reprogramada no AGENDAMENTO (valor, periodicidade e data);
 *  2. se a reprogramação falhar, a renovação que chega no valor antigo ADIA a troca —
 *     o cliente recebe o período que pagou, não o do plano menor;
 *  3. o downgrade comprado pela página de planos estende o período pelo ciclo que o
 *     cliente acabou de pagar e alinha a cobrança nova ao fim do tempo já pago.
 */

process.env.ASAAS_API_KEY = "chave-de-teste-nao-vai-para-a-rede";
process.env.ASAAS_ENV = "sandbox";

const contexto = vi.hoisted(() => ({ userId: "", orgId: "", subId: "" }));

/**
 * Só a sessão é substituída. A rota de mudar plano continua rodando de verdade — é
 * justamente o que ela faz (ou deixava de fazer) com o provedor que está em teste.
 */
vi.mock("@/lib/tenant", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/tenant")>();
  const { PrismaClient: PC } = await import("@prisma/client");
  const db = new PC();
  return {
    ...real,
    requireAppContext: async () => {
      const sub = await db.subscription.findUnique({ where: { id: contexto.subId } });
      const org = await db.organization.findUnique({ where: { id: contexto.orgId } });
      return {
        user: { id: contexto.userId, email: "cliente@teste.local", name: "Cliente", role: "CLIENTE" },
        organization: org,
        subscription: sub,
        currentSubscription: sub,
        access: { hasAccess: true, reason: "ativa", message: "" },
        quota: {},
      };
    },
  };
});

const { processAsaasEvent } = await import("../src/lib/asaas");
const { agendarDowngrade, aplicarPlanoAgendado } = await import("../src/lib/mudanca-plano");
const { POST: MUDAR_PLANO } = await import("../src/app/api/assinatura/mudar-plano/route");

const prisma = new PrismaClient();
const PREFIXO = "test-downgrade";
const REF_ASAAS = "sub_downgrade_teste";

let anualId = "";
let mensalId = "";

/** Corpos enviados ao Asaas, para conferir valor, ciclo e data da próxima cobrança. */
function capturarAsaas(status = 200) {
  const chamadas: { metodo: string; url: string; corpo: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    chamadas.push({
      metodo: String(init?.method ?? "GET"),
      url: String(url),
      corpo: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify({ id: REF_ASAAS }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return chamadas;
}

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orgs = await prisma.organization.findMany({
    where: { OR: [{ name: { startsWith: PREFIXO } }, { ownerId: { in: ids } }] },
    select: { id: true },
  });
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.payment.deleteMany({ where: { externalId: { startsWith: PREFIXO } } });
  await prisma.securityEvent.deleteMany({
    where: { metadata: { path: ["pagamento"], string_starts_with: PREFIXO } },
  });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

beforeAll(async () => {
  await limpar();
  const anual = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-anual`,
      name: "Anual (downgrade)",
      priceCents: 41900,
      period: "ANUAL",
      monthlyAnalyses: 20,
      maxUsers: 1,
    },
  });
  anualId = anual.id;
  const mensal = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-mensal`,
      name: "Mensal (downgrade)",
      priceCents: 4990,
      period: "MENSAL",
      monthlyAnalyses: 20,
      maxUsers: 1,
    },
  });
  mensalId = mensal.id;

  const user = await prisma.user.create({
    data: { email: `${PREFIXO}-cliente@exemplo.local`, name: "Cliente", passwordHash: "x", role: "CLIENTE" },
  });
  contexto.userId = user.id;
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org`, ownerId: user.id } });
  contexto.orgId = org.id;
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id, orgRole: "OWNER" } });
});

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  await prisma.payment.deleteMany({ where: { externalId: { startsWith: PREFIXO } } });
  await prisma.subscription.deleteMany({ where: { organizationId: contexto.orgId } });
});

/**
 * Assinatura ANUAL ativa, paga até `fimEmDias` dias à frente.
 *
 * Valor NEGATIVO põe o fim do período no passado — é o estado em que a renovação
 * chega de verdade. Sem isso, `pendingPlanAt` fica no futuro e o downgrade agendado
 * simplesmente não é aplicado: o teste passaria a exercitar "ainda não é hora", que
 * não é o que ele diz medir.
 */
async function assinaturaAnual(fimEmDias = 200) {
  const fim = new Date(Date.now() + fimEmDias * 86400000);
  const sub = await prisma.subscription.create({
    data: {
      organizationId: contexto.orgId,
      planId: anualId,
      status: "ATIVA",
      provider: "ASAAS",
      externalRef: REF_ASAAS,
      amountCents: 41900,
      currentPeriodEnd: fim,
      nextRenewalAt: fim,
      maxUsers: 1,
      analysesQuota: 20,
      analysesUsed: 0,
    },
  });
  contexto.subId = sub.id;
  return sub;
}

function pedidoDeTroca(slug: string) {
  return new Request("http://localhost/api/assinatura/mudar-plano", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planoSlug: slug }),
  }) as never;
}

// ---------------------------------------------------------------------------
// 1. A recorrência é reprogramada no agendamento
// ---------------------------------------------------------------------------

describe("agendamento do downgrade", () => {
  it("manda o Asaas mudar valor, PERIODICIDADE e data da próxima cobrança", async () => {
    const sub = await assinaturaAnual();
    const chamadas = capturarAsaas();

    const res = await MUDAR_PLANO(pedidoDeTroca(`${PREFIXO}-mensal`));
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.tipo).toBe("downgrade");
    expect(corpo.data.cobrancaAjustada).toBe(true);

    const put = chamadas.find((c) => c.metodo === "PUT");
    expect(put?.url).toContain(`/subscriptions/${REF_ASAAS}`);
    expect(put?.corpo.value).toBe(49.9);
    // Sem o ciclo, a recorrência ficaria ANUAL com o preço do mensal — ou o inverso.
    expect(put?.corpo.cycle).toBe("MONTHLY");
    // Sem a data, o Asaas reagendaria a cobrança pela nova periodicidade e cobraria
    // ANTES do fim do período que o cliente já pagou.
    expect(put?.corpo.nextDueDate).toBe(sub.currentPeriodEnd!.toISOString().slice(0, 10));
    // A cobrança em aberto do ciclo atual não pode ser alterada: já foi paga.
    expect(put?.corpo.updatePendingPayments).toBe(false);
  });

  it("o acesso e a cota do ciclo pago NÃO mudam agora", async () => {
    const sub = await assinaturaAnual();
    capturarAsaas();

    await MUDAR_PLANO(pedidoDeTroca(`${PREFIXO}-mensal`));

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.planId).toBe(anualId);
    expect(depois.currentPeriodEnd?.getTime()).toBe(sub.currentPeriodEnd?.getTime());
    expect(depois.pendingPlanId).toBe(mensalId);
  });

  it("a resposta explica a troca de periodicidade, não só o valor menor", async () => {
    await assinaturaAnual();
    capturarAsaas();

    const res = await MUDAR_PLANO(pedidoDeTroca(`${PREFIXO}-mensal`));
    const corpo = await res.json();

    // "O novo valor passa a ser cobrado" esconde, atrás de um número menor, que a
    // cobrança passa a ser mensal.
    expect(corpo.data.message).toContain("mensal");
  });

  it("falha do provedor não perde o agendamento, e a resposta não mente", async () => {
    const sub = await assinaturaAnual();
    capturarAsaas(503);

    const res = await MUDAR_PLANO(pedidoDeTroca(`${PREFIXO}-mensal`));
    const corpo = await res.json();

    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).pendingPlanId).toBe(mensalId);
    expect(corpo.data.cobrancaAjustada).toBe(false);
    expect(corpo.data.message).toContain("ATENÇÃO");
  });
});

// ---------------------------------------------------------------------------
// 2. A rede de segurança na renovação
// ---------------------------------------------------------------------------

describe("renovação com downgrade agendado", () => {
  /** Agenda o mensal sem falar com o provedor — simula a reprogramação que falhou. */
  async function agendarSemProvedor(sub: { id: string }) {
    return agendarDowngrade(sub.id, mensalId, { id: contexto.userId });
  }

  it("cobrança no valor ANTIGO adia a troca: o cliente recebe o período que pagou", async () => {
    const sub = await assinaturaAnual(-1);
    await agendarSemProvedor(sub);
    capturarAsaas();

    const r = await processAsaasEvent({
      event: "PAYMENT_CONFIRMED",
      // R$ 419,00: a recorrência continuou no anual.
      payment: { id: `${PREFIXO}-pay-anual`, subscription: REF_ASAAS, value: 419, billingType: "CREDIT_CARD" },
    });

    expect(r.action).toBe("aprovado");
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });

    // O plano NÃO trocou: trocar aqui daria 30 dias por um ano de dinheiro.
    expect(depois.planId).toBe(anualId);
    const meses = (depois.currentPeriodEnd!.getTime() - Date.now()) / 86400000;
    expect(meses).toBeGreaterThan(300);

    // E a troca passa a valer no fim do período que acabou de ser pago.
    expect(depois.pendingPlanId).toBe(mensalId);
    expect(depois.pendingPlanAt?.getTime()).toBe(depois.currentPeriodEnd?.getTime());
  });

  it("adiando, reprograma a recorrência e avisa a operação", async () => {
    const sub = await assinaturaAnual(-1);
    await agendarSemProvedor(sub);
    const chamadas = capturarAsaas();

    await processAsaasEvent({
      event: "PAYMENT_CONFIRMED",
      payment: { id: `${PREFIXO}-pay-anual-2`, subscription: REF_ASAAS, value: 419, billingType: "CREDIT_CARD" },
    });

    // A tentativa nova é o que faz o caso se resolver no ciclo seguinte.
    const put = chamadas.find((c) => c.metodo === "PUT");
    expect(put?.corpo.value).toBe(49.9);
    expect(put?.corpo.cycle).toBe("MONTHLY");

    // O cliente pagou um valor que não pediu: só uma pessoa decide devolver.
    const alerta = await prisma.securityEvent.findFirst({
      where: { type: "asaas_downgrade_cobrado_no_plano_antigo", metadata: { path: ["pagamento"], equals: `${PREFIXO}-pay-anual-2` } },
    });
    expect(alerta).not.toBeNull();
  });

  it("cobrança no valor CERTO aplica a troca e dá um mês", async () => {
    const sub = await assinaturaAnual(-1);
    await agendarSemProvedor(sub);
    capturarAsaas();

    await processAsaasEvent({
      event: "PAYMENT_CONFIRMED",
      payment: { id: `${PREFIXO}-pay-mensal`, subscription: REF_ASAAS, value: 49.9, billingType: "CREDIT_CARD" },
    });

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.planId).toBe(mensalId);
    expect(depois.amountCents).toBe(4990);
    expect(depois.pendingPlanId).toBeNull();
    const dias = (depois.currentPeriodEnd!.getTime() - Date.now()) / 86400000;
    expect(dias).toBeLessThan(40);
  });

  it("a rede só olha o valor quando os preços diferem", async () => {
    const sub = await assinaturaAnual(-1);
    await agendarSemProvedor(sub);

    // Sem valor no evento não há como comparar: aplica, como antes.
    const r = await aplicarPlanoAgendado(sub.id, { valorPagoCents: 0 });
    expect(r.aplicado).toBe(true);
    expect(r.adiado).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Downgrade comprado pela página de planos
// ---------------------------------------------------------------------------

describe("downgrade pelo checkout (página de planos)", () => {
  it("estende o período pelo ciclo pago e alinha a cobrança nova", async () => {
    const sub = await assinaturaAnual(200);
    const fimAnterior = sub.currentPeriodEnd!;
    await prisma.asaasCheckout.upsert({
      where: { id: `${PREFIXO}-sessao` },
      create: { id: `${PREFIXO}-sessao`, tipo: "plano", slug: `${PREFIXO}-mensal`, userId: contexto.userId },
      update: {},
    });
    const chamadas = capturarAsaas();

    await processAsaasEvent({
      event: "PAYMENT_CONFIRMED",
      payment: {
        id: `${PREFIXO}-pay-checkout`,
        subscription: "sub_recorrencia_nova",
        value: 49.9,
        billingType: "CREDIT_CARD",
        externalReference: `plano:${PREFIXO}-mensal:user:${contexto.userId}`,
      },
    });

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });

    // O dinheiro comprou um ciclo do plano novo: some-o ao tempo já pago, em vez de
    // deixá-lo sem efeito nenhum.
    expect(depois.currentPeriodEnd!.getTime()).toBeGreaterThan(fimAnterior.getTime());
    // O plano só troca no fim do período que o plano MAIOR pagou.
    expect(depois.planId).toBe(anualId);
    expect(depois.pendingPlanId).toBe(mensalId);
    expect(depois.pendingPlanAt?.getTime()).toBe(fimAnterior.getTime());

    // A recorrência NOVA cobraria de novo a partir de hoje, dentro de tempo já pago.
    const put = chamadas.find((c) => c.metodo === "PUT" && c.url.includes("sub_recorrencia_nova"));
    expect(put?.corpo.nextDueDate).toBe(depois.currentPeriodEnd!.toISOString().slice(0, 10));

    await prisma.asaasCheckout.deleteMany({ where: { id: `${PREFIXO}-sessao` } });
  });
});
