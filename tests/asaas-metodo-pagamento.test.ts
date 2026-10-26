import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Forma de pagamento × renovação.
 *
 * A regra comercial: no CARTÃO o Asaas cria uma assinatura e cobra sozinho a cada
 * ciclo; no PIX é cobrança ÚNICA e o acesso vale um ciclo, sem renovação.
 *
 * Não é escolha de interface — é o que o PIX permite. Não existe mandato de débito
 * em PIX comum, então o Asaas não tem como cobrar de novo. Boleto ficou de fora
 * porque o Checkout do Asaas não aceita boleto: `billingTypes` admite apenas
 * CREDIT_CARD e PIX (docs.asaas.com/reference/create-new-checkout).
 *
 * O que estes testes protegem é a promessa feita ao cliente: `nextRenewalAt` nulo
 * é o sinal, em toda a aplicação, de "vale um ciclo e encerra". Preencher a data
 * num pagamento PIX anunciaria uma renovação que nunca chega.
 */

process.env.ASAAS_API_KEY = "chave-de-teste-nao-vai-para-a-rede";
process.env.ASAAS_ENV = "sandbox";

const { processAsaasEvent, criarCheckout } = await import("../src/lib/asaas");
const { encerrarAssinaturasVencidas } = await import("../src/lib/mudanca-plano");
const { saldoDe } = await import("../src/lib/credits");
const { subscriptionGrantsAccess } = await import("../src/lib/consumption");

const prisma = new PrismaClient();
const PREFIXO = "test-metodo";
const SESSAO = "sessao-metodo-de-pagamento";

let userId = "";
let orgId = "";

/** Captura o corpo enviado ao Asaas para conferir billingTypes e chargeTypes. */
function capturarCheckout(idDaSessao = SESSAO) {
  const corpos: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const alvo = String(url);
    if (alvo.includes("/checkouts")) {
      corpos.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({ id: idDaSessao, link: `https://www.asaas.com/checkoutSession/show/${idDaSessao}` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 404 });
  });
  return corpos;
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
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.payment.deleteMany({ where: { externalId: { startsWith: PREFIXO } } });
  await prisma.asaasCheckout.deleteMany({ where: { id: SESSAO } });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

beforeAll(async () => {
  await limpar();
  await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-essencial`,
      name: "Essencial (método)",
      priceCents: 3990,
      period: "MENSAL",
      monthlyAnalyses: 6,
      maxUsers: 1,
    },
  });
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
  await prisma.payment.deleteMany({ where: { externalId: { startsWith: PREFIXO } } });
  await prisma.asaasCheckout.deleteMany({ where: { id: SESSAO } });

  const user = await prisma.user.create({
    data: { email: `${PREFIXO}-cliente@exemplo.local`, name: "Cliente Método", role: "CLIENTE", status: "ATIVO" },
  });
  userId = user.id;
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org`, ownerId: user.id } });
  orgId = org.id;
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id, orgRole: "OWNER" } });
  await prisma.asaasCheckout.create({
    data: { id: SESSAO, tipo: "plano", slug: `${PREFIXO}-essencial`, userId: user.id },
  });
});

describe("o que é enviado ao Asaas na abertura do checkout", () => {
  it("cartão pede assinatura recorrente", async () => {
    const corpos = capturarCheckout();
    await criarCheckout({
      tipo: "plano",
      slug: `${PREFIXO}-essencial`,
      nome: "Essencial",
      valorCents: 3990,
      userId,
      cycle: "MONTHLY",
      metodo: "cartao",
    });

    expect(corpos[0]!.billingTypes).toEqual(["CREDIT_CARD"]);
    expect(corpos[0]!.chargeTypes).toEqual(["RECURRENT"]);
    // O objeto `subscription` é o que faz o Asaas criar a recorrência.
    expect(corpos[0]!.subscription).toMatchObject({ cycle: "MONTHLY" });
  });

  it("PIX pede cobrança única e NÃO pede assinatura", async () => {
    const corpos = capturarCheckout();
    await criarCheckout({
      tipo: "plano",
      slug: `${PREFIXO}-essencial`,
      nome: "Essencial",
      valorCents: 3990,
      userId,
      cycle: "MONTHLY",
      metodo: "pix",
    });

    expect(corpos[0]!.billingTypes).toEqual(["PIX"]);
    expect(corpos[0]!.chargeTypes).toEqual(["DETACHED"]);
    // Mandar `subscription` aqui pediria ao Asaas uma recorrência que o PIX não
    // consegue cumprir.
    expect(corpos[0]!.subscription).toBeUndefined();
  });

  it("cartão é o padrão quando o método não é informado", async () => {
    const corpos = capturarCheckout();
    await criarCheckout({
      tipo: "plano",
      slug: `${PREFIXO}-essencial`,
      nome: "Essencial",
      valorCents: 3990,
      userId,
    });
    expect(corpos[0]!.chargeTypes).toEqual(["RECURRENT"]);
  });
});

describe("ativação conforme o método", () => {
  function evento(opcoes: { assinatura?: string; forma: string; pagamento: string }) {
    return {
      event: "PAYMENT_CONFIRMED",
      payment: {
        id: opcoes.pagamento,
        customer: `cus_${PREFIXO}`,
        subscription: opcoes.assinatura ?? null,
        checkoutSession: SESSAO,
        value: 39.9,
        billingType: opcoes.forma,
        status: "CONFIRMED",
        externalReference: null,
      },
    };
  }

  /**
   * LIBERAÇÃO IMEDIATA — o que este bloco prova.
   *
   * O Asaas manda `PAYMENT_CONFIRMED` na aprovação e `PAYMENT_RECEIVED` na
   * liquidação, que no cartão pode levar dias. Se o sistema só liberasse no
   * RECEIVED, o cliente pagaria e ficaria sem acesso esperando o dinheiro cair —
   * e no PIX, que confirma em segundos, a espera seria inexplicável.
   *
   * Por isso `classificar` trata os DOIS eventos como aprovação, e o que estes
   * testes travam não é o status: é `subscriptionGrantsAccess`, o gate que
   * realmente decide se a pessoa entra e roda análise.
   */
  it("PIX: acesso liberado no primeiro evento de confirmação, sem esperar liquidação", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const r = await processAsaasEvent(evento({ forma: "PIX", pagamento: `${PREFIXO}-pay-imediato-pix` }));
    expect(r.action).toBe("aprovado");

    const sub = await prisma.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    // O evento processado foi PAYMENT_CONFIRMED — nenhum RECEIVED chegou ainda.
    expect(subscriptionGrantsAccess(sub)).toBe(true);
    expect(saldoDe(sub).total).toBe(6);
  });

  it("cartão: acesso liberado na confirmação, antes da liquidação", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const r = await processAsaasEvent(
      evento({ assinatura: `${PREFIXO}-sub-imediato`, forma: "CREDIT_CARD", pagamento: `${PREFIXO}-pay-imediato-cartao` }),
    );
    expect(r.action).toBe("aprovado");

    const sub = await prisma.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(subscriptionGrantsAccess(sub)).toBe(true);
  });

  it("cartão: assinatura com data de renovação preenchida", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const r = await processAsaasEvent(
      evento({ assinatura: `${PREFIXO}-sub-1`, forma: "CREDIT_CARD", pagamento: `${PREFIXO}-pay-1` }),
    );
    expect(r.action).toBe("aprovado");

    const sub = await prisma.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(sub.status).toBe("ATIVA");
    expect(sub.nextRenewalAt).not.toBeNull();
    expect(saldoDe(sub).total).toBe(6);
  });

  it("PIX: mesmos créditos, mas SEM data de renovação", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const r = await processAsaasEvent(evento({ forma: "PIX", pagamento: `${PREFIXO}-pay-2` }));
    expect(r.action).toBe("aprovado");

    const sub = await prisma.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(sub.status).toBe("ATIVA");
    // O cliente pagou o ciclo: recebe a cota inteira.
    expect(saldoDe(sub).total).toBe(6);
    // Mas nada de prometer renovação.
    expect(sub.nextRenewalAt).toBeNull();
    // O acesso vale até o fim do ciclo.
    expect(sub.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("encerramento do ciclo único", () => {
  it("marca VENCIDA a contratação sem renovação cujo prazo passou", async () => {
    const sub = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId: (await prisma.plan.findFirstOrThrow({ where: { slug: `${PREFIXO}-essencial` } })).id,
        status: "ATIVA",
        provider: "ASAAS",
        amountCents: 3990,
        analysesQuota: 6,
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
        nextRenewalAt: null,
      },
    });

    const r = await encerrarAssinaturasVencidas();
    expect(r.encerradas).toBeGreaterThanOrEqual(1);

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("VENCIDA");
  });

  it("NÃO encerra assinatura de cartão vencida — quem decide é o gateway", async () => {
    const sub = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId: (await prisma.plan.findFirstOrThrow({ where: { slug: `${PREFIXO}-essencial` } })).id,
        status: "ATIVA",
        provider: "ASAAS",
        amountCents: 3990,
        analysesQuota: 6,
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
        // Tem renovação prevista: o Asaas pode estar processando a cobrança neste
        // instante. Encerrar aqui cortaria acesso de quem está pagando.
        nextRenewalAt: new Date(Date.now() - 86_400_000),
      },
    });

    await encerrarAssinaturasVencidas();

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("ATIVA");
  });

  it("não mexe em quem ainda está dentro do prazo", async () => {
    const sub = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId: (await prisma.plan.findFirstOrThrow({ where: { slug: `${PREFIXO}-essencial` } })).id,
        status: "ATIVA",
        provider: "ASAAS",
        amountCents: 3990,
        analysesQuota: 6,
        currentPeriodEnd: new Date(Date.now() + 10 * 86_400_000),
        nextRenewalAt: null,
      },
    });

    await encerrarAssinaturasVencidas();

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("ATIVA");
  });
});
