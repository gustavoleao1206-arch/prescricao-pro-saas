import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * O payload REAL da primeira cobrança de uma assinatura recorrente.
 *
 * ── Por que este arquivo existe ───────────────────────────────────────────────
 * O primeiro pagamento de verdade em produção (01/08/2026, R$ 39,90 no cartão)
 * NÃO liberou nada, e os 26 testes do Asaas passavam. A causa: numa cobrança
 * recorrente o Asaas guarda o `externalReference` na ASSINATURA e manda os
 * pagamentos dela com `externalReference: null`. Este é o corpo que ele enviou,
 * copiado do log de webhooks do painel (identificadores trocados por fictícios):
 *
 *   { "event": "PAYMENT_CONFIRMED",
 *     "payment": { "id": "pay_k3v9x2m7q1w8z4ta", "status": "CONFIRMED",
 *                  "value": 39.9, "billingType": "CREDIT_CARD",
 *                  "customer": "cus_000100000001",
 *                  "subscription": "sub_m2c8t5x1k9q3w7ra",
 *                  "externalReference": null } }
 *
 * Os testes existentes não pegaram porque os payloads tinham sido fabricados com
 * `externalReference` preenchido na primeira cobrança: a suposição errada estava
 * no código e no teste, então um confirmava o outro. É a lição deste arquivo —
 * quando o formato vem de fora, o caso de teste tem de ser o corpo real, não o
 * que se imagina que o provedor manda.
 *
 * O `fetch` global é substituído para simular a consulta da assinatura no Asaas,
 * que é como a referência é recuperada. Nada sai para a rede.
 */

// A chave precisa existir ANTES de `env` ser lido, senão `asaasFetch` recusa a
// chamada e a recuperação da referência nem é tentada.
process.env.ASAAS_API_KEY = "chave-de-teste-nao-vai-para-a-rede";
process.env.ASAAS_ENV = "sandbox";

const { processAsaasEvent, criarCheckout } = await import("../src/lib/asaas");
const { saldoDe } = await import("../src/lib/credits");

const prisma = new PrismaClient();
const PREFIXO = "test-real";
const ASSINATURA_ASAAS = "sub_m2c8t5x1k9q3w7ra";
const PAGAMENTO_ASAAS = "pay_k3v9x2m7q1w8z4ta";
// Sessão de checkout que originou a assinatura (id fictício, no formato do Asaas).
const SESSAO_CHECKOUT = "3f6c1a2e-5b7d-4c9e-8a1f-0d2b4e6c8a10";

let userId = "";
let orgId = "";
let planoId = "";

/** Corpo exatamente como o Asaas envia: sem externalReference no pagamento. */
function eventoReal(evento: string, pagamentoId = PAGAMENTO_ASAAS) {
  return {
    id: `evt_${pagamentoId}`,
    event: evento,
    dateCreated: "2026-08-01 00:30:36",
    payment: {
      object: "payment",
      id: pagamentoId,
      dateCreated: "2026-08-01",
      customer: "cus_000100000001",
      subscription: ASSINATURA_ASAAS,
      value: 39.9,
      netValue: 38.31,
      billingType: "CREDIT_CARD",
      status: "CONFIRMED",
      dueDate: "2026-08-01",
      externalReference: null as string | null,
    },
  };
}

/**
 * Substitui o fetch para responder à consulta da assinatura.
 *
 * A resposta imita a REAL, conferida na API em 01/08/2026 com o pagamento de
 * R$ 39,90: `externalReference` **nulo** e `checkoutSession` preenchido. Era o
 * inverso do que se havia suposto, e é por isso que este simulador devolve nulo
 * por padrão — o teste tem de partir do que o provedor faz, não do que conviria.
 */
function simularAsaas(
  opcoes: { externalReference?: string | null; checkoutSession?: string | null } = {},
) {
  const chamadas: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const alvo = String(url);
    chamadas.push(alvo);
    if (alvo.includes("/subscriptions/")) {
      return new Response(
        JSON.stringify({
          object: "subscription",
          id: ASSINATURA_ASAAS,
          customer: "cus_000100000001",
          value: 39.9,
          cycle: "MONTHLY",
          status: "ACTIVE",
          externalReference: opcoes.externalReference ?? null,
          checkoutSession: opcoes.checkoutSession ?? null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ errors: [{ description: "rota não simulada" }] }), { status: 404 });
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
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  // Pagamento nao cascateia com a assinatura: sai pelo externalId.
  await prisma.payment.deleteMany({ where: { externalId: { startsWith: "pay_" } } });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

beforeAll(async () => {
  await limpar();
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-essencial`,
      name: "Essencial (payload real)",
      priceCents: 3990,
      period: "MENSAL",
      monthlyAnalyses: 6,
      maxUsers: 1,
    },
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
  await prisma.payment.deleteMany({ where: { externalId: { startsWith: "pay_" } } });

  // O cliente já tem conta quando paga: cadastra-se e depois assina.
  const user = await prisma.user.create({
    data: {
      email: `${PREFIXO}-cliente@exemplo.local`,
      name: "Cliente Payload Real",
      role: "CLIENTE",
      status: "ATIVO",
      emailVerifiedAt: new Date(),
    },
  });
  userId = user.id;
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org`, ownerId: user.id } });
  orgId = org.id;
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id, orgRole: "OWNER" } });

  // O vínculo que `criarCheckout` grava ao abrir a sessão de pagamento.
  await prisma.asaasCheckout.deleteMany({ where: { id: SESSAO_CHECKOUT } });
  await prisma.asaasCheckout.create({
    data: { id: SESSAO_CHECKOUT, tipo: "plano", slug: `${PREFIXO}-essencial`, userId: user.id },
  });
});

describe("abertura do checkout grava o vínculo", () => {
  it("registra a sessão de checkout apontando para quem está comprando", async () => {
    const NOVA_SESSAO = "sessao-de-teste-recem-criada";
    await prisma.asaasCheckout.deleteMany({ where: { id: NOVA_SESSAO } });

    vi.stubGlobal("fetch", async (url: string | URL) =>
      String(url).includes("/checkouts")
        ? new Response(
            JSON.stringify({
              id: NOVA_SESSAO,
              link: `https://www.asaas.com/checkoutSession/show/${NOVA_SESSAO}`,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        : new Response("{}", { status: 404 }),
    );

    const r = await criarCheckout({
      tipo: "plano",
      slug: `${PREFIXO}-essencial`,
      nome: "Essencial",
      valorCents: 3990,
      userId,
      cycle: "MONTHLY",
    });
    expect(r.url).toContain(NOVA_SESSAO);

    /**
     * Esta linha é o que impede o defeito de produção de voltar: sem ela, o
     * webhook da assinatura não tem como saber de quem é o pagamento.
     */
    const vinculo = await prisma.asaasCheckout.findUnique({ where: { id: NOVA_SESSAO } });
    expect(vinculo).toBeTruthy();
    expect(vinculo!.userId).toBe(userId);
    expect(vinculo!.tipo).toBe("plano");
    expect(vinculo!.slug).toBe(`${PREFIXO}-essencial`);

    await prisma.asaasCheckout.deleteMany({ where: { id: NOVA_SESSAO } });
  });

  it("não derruba a compra se o registro do vínculo falhar", async () => {
    // Usuário inexistente faz a chave estrangeira recusar a gravação. O cliente
    // já está indo pagar: a falha vira aviso no log, não erro na cara dele.
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ id: "sessao-orfa", link: "https://www.asaas.com/checkoutSession/show/sessao-orfa" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const r = await criarCheckout({
      tipo: "plano",
      slug: `${PREFIXO}-essencial`,
      nome: "Essencial",
      valorCents: 3990,
      userId: "usuario-que-nao-existe",
    });
    expect(r.url).toContain("sessao-orfa");
  });
});

describe("sessão de checkout vem no próprio pagamento", () => {
  /**
   * Corpo do segundo pagamento real, copiado do log do painel (identificadores fictícios). Diferente do
   * primeiro em tudo — id, customer, assinatura — e com `checkoutSession` DENTRO
   * de `payment`. É o caminho curto: resolve sem consultar a assinatura.
   */
  const SEGUNDA_SESSAO = "9d4e2b7c-1a3f-4e8d-b6c5-7f0a2e9d1b34";

  it("resolve pelo campo do pagamento, sem chamar a API do Asaas", async () => {
    await prisma.asaasCheckout.create({
      data: { id: SEGUNDA_SESSAO, tipo: "plano", slug: `${PREFIXO}-essencial`, userId },
    });
    const chamadas = simularAsaas({});

    const r = await processAsaasEvent({
      id: "evt_0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f",
      event: "PAYMENT_CONFIRMED",
      payment: {
        object: "payment",
        id: "pay_r5n2b8d6h4j0p7sy",
        customer: "cus_000100000002",
        subscription: "sub_y6h3n0p4f8b2v5ld",
        checkoutSession: SEGUNDA_SESSAO,
        paymentLink: null,
        value: 39.9,
        billingType: "CREDIT_CARD",
        status: "CONFIRMED",
        externalReference: null,
      },
    });

    expect(r.action).toBe("aprovado");
    // Nenhuma consulta à assinatura: o dado já estava no evento. Uma chamada de
    // API a menos é um ponto de falha a menos no caminho do dinheiro.
    expect(chamadas.filter((c) => c.includes("/subscriptions/"))).toHaveLength(0);

    const sub = await prisma.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(sub.status).toBe("ATIVA");
    expect(sub.externalRef).toBe("sub_y6h3n0p4f8b2v5ld");
    expect(saldoDe(sub).total).toBe(6);

    await prisma.asaasCheckout.deleteMany({ where: { id: SEGUNDA_SESSAO } });
  });

  it("encerra a recorrência anterior quando chega uma segunda para o mesmo cliente", async () => {
    // Primeiro pagamento: cria a assinatura, vinculada a sub_m2c8...
    simularAsaas({ checkoutSession: SESSAO_CHECKOUT });
    await processAsaasEvent(eventoReal("PAYMENT_CONFIRMED"));
    const primeira = await prisma.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(primeira.externalRef).toBe(ASSINATURA_ASAAS);

    // Segundo pagamento, de OUTRA sessão e OUTRA assinatura — foi o que aconteceu
    // em produção quando o cliente pagou de novo por o primeiro não ter liberado.
    await prisma.asaasCheckout.create({
      data: { id: SEGUNDA_SESSAO, tipo: "plano", slug: `${PREFIXO}-essencial`, userId },
    });
    const chamadas = simularAsaas({});
    await processAsaasEvent({
      event: "PAYMENT_CONFIRMED",
      payment: {
        id: "pay_r5n2b8d6h4j0p7sy",
        customer: "cus_000100000002",
        subscription: "sub_y6h3n0p4f8b2v5ld",
        checkoutSession: SEGUNDA_SESSAO,
        value: 39.9,
        billingType: "CREDIT_CARD",
        status: "CONFIRMED",
        externalReference: null,
      },
    });

    // A recorrência ANTIGA tem de receber um pedido de cancelamento no Asaas,
    // senão o cliente é cobrado pelas duas todo mês.
    const cancelamento = chamadas.find((c) => c.includes(`/subscriptions/${ASSINATURA_ASAAS}`));
    expect(cancelamento).toBeTruthy();

    const depois = await prisma.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(depois.externalRef).toBe("sub_y6h3n0p4f8b2v5ld");
    // Mesmo mês: a cota não dobra por causa da segunda cobrança.
    expect(depois.analysesQuota).toBe(6);

    await prisma.asaasCheckout.deleteMany({ where: { id: SEGUNDA_SESSAO } });
  });
});

describe("primeira cobrança de assinatura recorrente (payload real)", () => {
  it("libera o acesso mesmo com externalReference nulo no pagamento", async () => {
    const chamadas = simularAsaas({ checkoutSession: SESSAO_CHECKOUT });

    const r = await processAsaasEvent(eventoReal("PAYMENT_CONFIRMED"));

    // Era exatamente aqui que produção devolvia "ignorado" com 200.
    expect(r.action).toBe("aprovado");

    // Consultou a ASSINATURA, que é onde a referência mora.
    expect(chamadas.some((c) => c.includes(`/subscriptions/${ASSINATURA_ASAAS}`))).toBe(true);

    const sub = await prisma.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(sub.status).toBe("ATIVA");
    expect(sub.provider).toBe("ASAAS");
    expect(sub.planId).toBe(planoId);
    expect(sub.amountCents).toBe(3990);
    expect(saldoDe(sub).total).toBe(6);

    // Guarda o id da assinatura do Asaas: é o vínculo das renovações.
    expect(sub.externalRef).toBe(ASSINATURA_ASAAS);

    const pago = await prisma.payment.count({
      where: { subscriptionId: sub.id, externalId: PAGAMENTO_ASAAS, status: "APROVADO" },
    });
    expect(pago).toBe(1);
  });

  it("o par CONFIRMED→RECEIVED do payload real não credita duas vezes", async () => {
    simularAsaas({ checkoutSession: SESSAO_CHECKOUT });

    await processAsaasEvent(eventoReal("PAYMENT_CONFIRMED"));
    await processAsaasEvent(eventoReal("PAYMENT_RECEIVED"));

    const sub = await prisma.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(sub.analysesQuota).toBe(6); // não 12
    const liberacoes = await prisma.creditLedger.count({ where: { subscriptionId: sub.id, kind: "ASSINATURA" } });
    expect(liberacoes).toBe(1);
  });

  it("não consulta a assinatura de novo na renovação — o vínculo já é local", async () => {
    simularAsaas({ checkoutSession: SESSAO_CHECKOUT });
    await processAsaasEvent(eventoReal("PAYMENT_CONFIRMED"));

    // A renovação chega com outro id de pagamento, mesma assinatura.
    const chamadasDaRenovacao = simularAsaas({ checkoutSession: SESSAO_CHECKOUT });
    const r = await processAsaasEvent(eventoReal("PAYMENT_CONFIRMED", "pay_renovacao_do_mes_seguinte"));

    expect(r.action).toBe("aprovado");
    // Chamada de API a cada renovação seria desperdício — e um ponto de falha a mais.
    expect(chamadasDaRenovacao.filter((c) => c.includes("/subscriptions/"))).toHaveLength(0);

    const sub = await prisma.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    const pagamentos = await prisma.payment.count({ where: { subscriptionId: sub.id, status: "APROVADO" } });
    expect(pagamentos).toBe(2);
  });

  it("registra e ignora quando o Asaas não devolve referência utilizável", async () => {
    simularAsaas({ checkoutSession: null });

    const r = await processAsaasEvent(eventoReal("PAYMENT_CONFIRMED", "pay_sem_referencia"));

    // Sem saber de quem é o dinheiro, não se inventa dono — mas o dinheiro EXISTE.
    expect(r.action).toBe("ignorado");
    const subs = await prisma.subscription.count({ where: { organizationId: orgId } });
    expect(subs).toBe(0);
    /**
     * O rastro que importa é a quantia gravada, não um evento de segurança achado com
     * `findFirst` na tabela inteira: aquela busca encontrava linhas de outros testes e
     * sobreviveu à mudança do tipo de evento provando o passado em vez do código. Este
     * pagamento é identificado pelo próprio id.
     */
    const registro = await prisma.payment.findFirst({ where: { externalId: "pay_sem_referencia" } });
    expect(registro?.status).toBe("PENDENTE");
    expect(registro?.subscriptionId).toBeNull();
  });
});
