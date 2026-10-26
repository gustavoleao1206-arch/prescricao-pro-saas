import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Boleto: contratação, renovação e cancelamento por vencimento.
 *
 * O boleto é o único método que NÃO passa pelo checkout hospedado — o Asaas não o
 * emite lá (`billingTypes` aceita só CREDIT_CARD e PIX). Ele vive na API de
 * Assinaturas, que exige criar um cliente com CPF/CNPJ antes da cobrança.
 *
 * Três regras do dono, e cada uma tem um teste que a trava:
 *  1. boleto RENOVA a cada ciclo (o Asaas emite o próximo);
 *  2. boleto vencido sem pagamento CANCELA a assinatura;
 *  3. o acesso só entra quando o banco confirma o pagamento.
 *
 * O ponto delicado é a regra 2 contra a regra 3. O Asaas manda `PAYMENT_OVERDUE`
 * no dia seguinte ao vencimento, mas boleto pago NO DIA do vencimento só compensa
 * de 1 a 3 dias úteis depois. Cancelar no primeiro evento de atraso cortaria quem
 * pagou em dia, e o dinheiro cairia numa assinatura já encerrada. Por isso o
 * cancelamento espera a janela de compensação — e é isso que os testes de
 * `encerrarBoletosVencidos` verificam.
 */

process.env.ASAAS_API_KEY = "chave-de-teste-nao-vai-para-a-rede";
process.env.ASAAS_ENV = "sandbox";

const {
  processAsaasEvent,
  criarCheckout,
  criarAssinaturaBoleto,
  encerrarBoletosVencidos,
  metodoDeTexto,
  MOTIVO_BOLETO_VENCIDO,
  METODOS_DE_PLANO,
} = await import("../src/lib/asaas");
const { DIAS_COMPENSACAO_BOLETO, DIAS_TOLERANCIA_INADIMPLENCIA } = await import("../src/lib/planos");
const { saldoDe } = await import("../src/lib/credits");

const prisma = new PrismaClient();
const PREFIXO = "test-boleto";
const SUB_ASAAS = "sub_boleto_teste";

let userId = "";
let orgId = "";
let planId = "";

/**
 * Simula a API do Asaas para a criação de cliente + assinatura + listagem de
 * cobranças, guardando os corpos enviados. Nada vai para a rede.
 */
function capturarAsaas() {
  const chamadas: { caminho: string; corpo: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const alvo = String(url);
    const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const json = (dados: unknown) =>
      new Response(JSON.stringify(dados), { status: 200, headers: { "Content-Type": "application/json" } });

    if (alvo.includes("/customers")) {
      chamadas.push({ caminho: "/customers", corpo });
      return json({ id: "cus_boleto_teste" });
    }
    if (alvo.includes("/subscriptions") && alvo.endsWith("/payments")) {
      chamadas.push({ caminho: "/subscriptions/:id/payments", corpo });
      return json({
        data: [
          {
            id: "pay_boleto_1",
            bankSlipUrl: "https://sandbox.asaas.com/b/pdf/abc123",
            invoiceUrl: "https://sandbox.asaas.com/i/abc123",
            dueDate: "2026-08-10",
          },
        ],
      });
    }
    if (alvo.includes("/subscriptions")) {
      chamadas.push({ caminho: "/subscriptions", corpo });
      return json({ id: SUB_ASAAS });
    }
    return new Response("{}", { status: 404 });
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
  // Pagamento NÃO cascateia com a assinatura: apagar por externalId é o único jeito
  // de não deixar órfão para trás.
  await prisma.payment.deleteMany({ where: { externalId: { startsWith: PREFIXO } } });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });

  /**
   * ⚠️ Registro de auditoria da RECORRÊNCIA: o laço acima não o alcança.
   *
   * Ele apaga auditoria por `entityId in ids` — ids de CONTA. Os registros de contratação
   * abandonada usam como `entityId` o id da recorrência no Asaas, e os de estorno de outro
   * contrato, o id da assinatura. Nenhum dos dois é conta, então sobravam entre execuções.
   *
   * Isso não é sujeira inofensiva: é justamente o que faz o teste de "avisa UMA vez" passar
   * medindo o resto da rodada anterior em vez do código. Na segunda execução o registro
   * antigo já estava lá, a função não avisava de novo, e a contagem dava 1 — o mesmo número
   * que daria se o código não fizesse nada. Teste que passa sem provar nada é pior que
   * teste ausente, porque dá confiança.
   */
  await prisma.auditLog.deleteMany({
    where: { entityId: { startsWith: `sub_${PREFIXO.replace(/-/g, "_")}` } },
  });
  await prisma.auditLog.deleteMany({
    where: { metadata: { path: ["pagamento"], string_starts_with: PREFIXO } },
  });
}

beforeAll(async () => {
  await limpar();
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-mensal`,
      name: "Prescrição Pro (boleto)",
      priceCents: 4990,
      period: "MENSAL",
      // 0 = sem limite, que é o plano real hoje.
      monthlyAnalyses: 0,
      maxUsers: 1,
    },
  });
  planId = plano.id;
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

  const user = await prisma.user.create({
    data: { email: `${PREFIXO}-cliente@exemplo.local`, name: "Cliente Boleto", role: "CLIENTE", status: "ATIVO" },
  });
  userId = user.id;
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org`, ownerId: user.id } });
  orgId = org.id;
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id, orgRole: "OWNER" } });
});

describe("emissão do boleto", () => {
  it("cria cliente com CPF e assinatura recorrente em BOLETO", async () => {
    const chamadas = capturarAsaas();

    const r = await criarAssinaturaBoleto({
      userId,
      nome: "Cliente Boleto",
      email: `${PREFIXO}-cliente@exemplo.local`,
      cpfCnpj: "52998224725",
      planoSlug: `${PREFIXO}-mensal`,
      planoNome: "Prescrição Pro",
      valorCents: 4990,
      cycle: "MONTHLY",
    });

    const cliente = chamadas.find((c) => c.caminho === "/customers")!;
    expect(cliente.corpo.cpfCnpj).toBe("52998224725");
    // A referência do cliente permite reconhecê-lo depois SEM consultar por CPF,
    // que é dado sensível.
    expect(cliente.corpo.externalReference).toBe(`user:${userId}`);

    const assinatura = chamadas.find((c) => c.caminho === "/subscriptions")!;
    expect(assinatura.corpo.billingType).toBe("BOLETO");
    expect(assinatura.corpo.cycle).toBe("MONTHLY");
    expect(assinatura.corpo.value).toBe(49.9);
    /**
     * ESTA linha é a que faz o webhook saber de quem é o dinheiro.
     *
     * No boleto não existe sessão de checkout para consultar — o vínculo que salvou
     * o primeiro pagamento real (AsaasCheckout) não se aplica aqui. Se a referência
     * não for gravada na assinatura, o pagamento entra e não há como identificar o
     * comprador.
     */
    expect(assinatura.corpo.externalReference).toBe(`plano:${PREFIXO}-mensal:user:${userId}`);

    expect(r.assinaturaId).toBe(SUB_ASAAS);
    expect(r.boletoUrl).toContain("/b/pdf/");
    expect(r.vencimento).toBe("2026-08-10");
  });

  it("assinatura vale mesmo quando a listagem do boleto falha", async () => {
    /**
     * A assinatura foi criada; só a consulta do PDF caiu. Devolver erro aqui diria
     * ao cliente que a contratação falhou quando ela existe — e o Asaas manda o
     * boleto por e-mail de qualquer forma. Erro de tela sobre algo que deu certo
     * gera cliente pagando duas vezes.
     */
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const alvo = String(url);
      if (alvo.includes("/customers")) {
        return new Response(JSON.stringify({ id: "cus_x" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (alvo.includes("/subscriptions") && alvo.endsWith("/payments")) {
        return new Response(JSON.stringify({ errors: [{ description: "instabilidade" }] }), { status: 500 });
      }
      return new Response(JSON.stringify({ id: SUB_ASAAS }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const r = await criarAssinaturaBoleto({
      userId,
      nome: "Cliente Boleto",
      email: `${PREFIXO}-cliente@exemplo.local`,
      cpfCnpj: "52998224725",
      planoSlug: `${PREFIXO}-mensal`,
      planoNome: "Prescrição Pro",
      valorCents: 4990,
      cycle: "MONTHLY",
    });

    expect(r.assinaturaId).toBe(SUB_ASAAS);
    expect(r.boletoUrl).toBeNull();
  });

  it("o checkout hospedado RECUSA boleto em vez de virar cartão silenciosamente", async () => {
    /**
     * O Checkout do Asaas não emite boleto. Antes, qualquer método diferente de
     * "pix" era tratado como cartão: um pedido de boleto abriria um checkout de
     * CARTÃO e o cliente contrataria o que não escolheu. Falhar alto é o certo.
     */
    await expect(
      criarCheckout({
        tipo: "plano",
        slug: `${PREFIXO}-mensal`,
        nome: "Prescrição Pro",
        valorCents: 4990,
        userId,
        cycle: "MONTHLY",
        metodo: "boleto",
      }),
    ).rejects.toThrow(/não emite boleto/i);
  });

  it("boleto é oferecido como método que RENOVA", () => {
    const boleto = METODOS_DE_PLANO.find((m) => m.valor === "boleto")!;
    expect(boleto.renova).toBe(true);
    // E não passa pelo checkout hospedado.
    expect(boleto.viaCheckout).toBe(false);
    expect(metodoDeTexto("boleto")).toBe("boleto");
    // Texto desconhecido cai no cartão, nunca em erro de tela.
    expect(metodoDeTexto("cheque")).toBe("cartao");
    expect(metodoDeTexto(null)).toBe("cartao");
  });
});

describe("substituir uma contratação anterior", () => {
  /**
   * Regra de coexistência, e ela custou uma venda perdida.
   *
   * A rota do boleto recusava QUALQUER assinatura ATIVA. Isso barrava exatamente
   * quem mais precisa do boleto: quem pagou por PIX, cujo acesso vale um ciclo e
   * ENCERRA. A pessoa via "você já tem assinatura ativa" e era mandada para "Mudar
   * de plano", que troca o plano e não a forma de pagamento — sem saída dentro do
   * produto.
   *
   * O que não pode coexistir são duas RECORRÊNCIAS. `nextRenewalAt` preenchido é o
   * sinal de "se cobra sozinha", e é ele que decide.
   */
  it("ativar por boleto ATUALIZA a assinatura da organização, não cria uma segunda", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));

    // Contratação anterior por PIX: ciclo único, sem renovação, externalRef = pagamento.
    const anterior = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "ATIVA",
        provider: "ASAAS",
        externalRef: `${PREFIXO}-pay-pix-anterior`,
        amountCents: 4990,
        analysesQuota: 0,
        currentPeriodEnd: new Date(Date.now() + 3 * 86_400_000),
        nextRenewalAt: null,
      },
    });

    const r = await processAsaasEvent({
      event: "PAYMENT_RECEIVED",
      payment: {
        id: `${PREFIXO}-pay-boleto-novo`,
        customer: "cus_boleto_teste",
        subscription: SUB_ASAAS,
        value: 49.9,
        billingType: "BOLETO",
        status: "RECEIVED",
        externalReference: `plano:${PREFIXO}-mensal:user:${userId}`,
      },
    });
    expect(r.action).toBe("aprovado");

    const todas = await prisma.subscription.findMany({ where: { organizationId: orgId } });
    expect(todas.length, "a organização ficou com mais de uma assinatura").toBe(1);
    expect(todas[0]!.id).toBe(anterior.id);
    // Agora renova: o boleto do ciclo seguinte é emitido pelo Asaas.
    expect(todas[0]!.externalRef).toBe(SUB_ASAAS);
    expect(todas[0]!.nextRenewalAt).not.toBeNull();
  });

  it("não tenta cancelar recorrência quando a anterior era cobrança única", async () => {
    /**
     * `externalRef` de PIX guarda o id do PAGAMENTO (`pay_...`), não de uma
     * assinatura. Chamar DELETE /subscriptions com ele devolve erro e registrava um
     * evento de segurança de "recorrência duplicada" que não existe — ruído no
     * caminho normal de quem pagou por PIX e depois assinou.
     */
    const chamadas: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      chamadas.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response("{}", { status: 404 });
    });

    await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "ATIVA",
        provider: "ASAAS",
        externalRef: "pay_cobranca_unica_anterior",
        amountCents: 4990,
        analysesQuota: 0,
        currentPeriodEnd: new Date(Date.now() + 3 * 86_400_000),
        nextRenewalAt: null,
      },
    });

    await processAsaasEvent({
      event: "PAYMENT_RECEIVED",
      payment: {
        id: `${PREFIXO}-pay-boleto-2`,
        customer: "cus_boleto_teste",
        subscription: SUB_ASAAS,
        value: 49.9,
        billingType: "BOLETO",
        status: "RECEIVED",
        externalReference: `plano:${PREFIXO}-mensal:user:${userId}`,
      },
    });

    expect(chamadas.some((c) => c.startsWith("DELETE") && c.includes("pay_cobranca_unica_anterior"))).toBe(false);
  });
});

/**
 * ── Contratação por boleto ABANDONADA ────────────────────────────────────────
 *
 * A contratação cria a recorrência no ASAAS e não cria assinatura aqui — a nossa só nasce
 * quando o pagamento é confirmado. Quem desiste deixa uma recorrência VIVA no provedor,
 * emitindo boleto a cada ciclo, e os eventos dela chegavam a um lugar errado.
 */
describe("contratação abandonada", () => {
  it("vencimento sem assinatura local avisa, em vez de sumir em silêncio", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));

    const r = await processAsaasEvent({
      event: "PAYMENT_OVERDUE",
      payment: {
        id: `${PREFIXO}-pay-abandonado`,
        customer: "cus_boleto_teste",
        subscription: "sub_test_boleto_abandonada",
        value: 49.9,
        billingType: "BOLETO",
        status: "OVERDUE",
        externalReference: `plano:${PREFIXO}-mensal:user:${userId}`,
      },
    });

    expect(r.action).toBe("ignorado");
    const registro = await prisma.auditLog.findFirst({
      where: {
        action: "asaas.contratacao_sem_assinatura_local",
        metadata: { path: ["recorrencia"], equals: "sub_test_boleto_abandonada" },
      },
    });
    expect(registro).not.toBeNull();
  });

  it("avisa UMA vez por recorrência, não a cada boleto vencido", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const vencido = (id: string) => ({
      event: "PAYMENT_OVERDUE",
      payment: {
        id: `${PREFIXO}-pay-${id}`,
        customer: "cus_boleto_teste",
        subscription: "sub_test_boleto_repete",
        value: 49.9,
        billingType: "BOLETO",
        status: "OVERDUE",
        externalReference: `plano:${PREFIXO}-mensal:user:${userId}`,
      },
    });

    await processAsaasEvent(vencido("ab1"));
    await processAsaasEvent(vencido("ab2"));

    // Alerta repetido a cada ciclo viraria ruído no canal que precisa ser lido.
    expect(
      await prisma.auditLog.count({
        where: {
          action: "asaas.contratacao_sem_assinatura_local",
          metadata: { path: ["recorrencia"], equals: "sub_test_boleto_repete" },
        },
      }),
    ).toBe(1);
  });

  /**
   * O achado que apareceu ao mapear a contratação abandonada, e é pior que a bagunça no
   * provedor: `acharSub` chega à conta pela referência e pega a assinatura MAIS RECENTE
   * dela, qualquer que seja a recorrência. Então o boleto abandonado de uma contratação
   * nova derrubava a assinatura que o cliente tinha PAGA.
   */
  it("boleto abandonado NÃO derruba a assinatura paga da mesma conta", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    // Assinatura em dia, paga por PIX: ciclo único, `externalRef` com id de PAGAMENTO.
    const paga = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "ATIVA",
        provider: "ASAAS",
        externalRef: `${PREFIXO}-pay-pix-em-dia`,
        amountCents: 4990,
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
        maxUsers: 1,
        analysesQuota: 20,
      },
    });

    await processAsaasEvent({
      event: "PAYMENT_OVERDUE",
      payment: {
        id: `${PREFIXO}-pay-outra-recorrencia`,
        customer: "cus_boleto_teste",
        subscription: "sub_test_boleto_nova",
        value: 49.9,
        billingType: "BOLETO",
        status: "OVERDUE",
        externalReference: `plano:${PREFIXO}-mensal:user:${userId}`,
      },
    });

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: paga.id } });
    // Perder a assinatura paga por causa de cobrança não paga de OUTRA contratação.
    expect(depois.status).toBe("ATIVA");
    expect(depois.canceledReason).toBeNull();
    expect(depois.graceUntil).toBeNull();
  });

  it("apagar a cobrança de outra recorrência NÃO cancela a assinatura paga", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const paga = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "ATIVA",
        provider: "ASAAS",
        externalRef: `${PREFIXO}-pay-pix-em-dia-2`,
        amountCents: 4990,
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
        maxUsers: 1,
        analysesQuota: 20,
      },
    });

    await processAsaasEvent({
      event: "PAYMENT_DELETED",
      payment: {
        id: `${PREFIXO}-pay-apagado-outra`,
        customer: "cus_boleto_teste",
        subscription: "sub_test_boleto_nova_2",
        value: 49.9,
        billingType: "BOLETO",
        externalReference: `plano:${PREFIXO}-mensal:user:${userId}`,
      },
    });

    // Aqui o estrago era imediato: limpar a lista de cobranças derrubava contrato em dia.
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: paga.id } });
    expect(depois.status).toBe("ATIVA");
    expect(depois.canceledAt).toBeNull();
  });
});

/**
 * O MESMO furo pelo caminho mais destrutivo do sistema.
 *
 * `acharSub` era usada em três lugares e o guarda de recorrência só entrou em dois — atraso
 * e cobrança apagada. `handleEstorno` ficou de fora, e é o que faz tudo de uma vez: status
 * ESTORNADA (o login passa a ser RECUSADO), todo o saldo bloqueado, a recorrência encerrada
 * no provedor e um e-mail ao cliente dizendo "assinatura encerrada por estorno".
 *
 * O caminho: o cliente pagou por boleto, depois trocou para PIX — e `ativarAssinatura`
 * ATUALIZA a assinatura da organização, então o `externalRef` passou a apontar para a
 * contratação nova e a antiga deixou de existir aqui. A devolução de um boleto antigo, ou a
 * CONTESTAÇÃO dele, caía sobre o contrato atual, pago e em dia.
 */
describe("estorno de cobrança de OUTRA recorrência", () => {
  /** Assinatura em dia paga por PIX: ciclo único, `externalRef` com id de PAGAMENTO. */
  async function assinaturaPagaPorPix(sufixo: string) {
    return prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "ATIVA",
        provider: "ASAAS",
        externalRef: `${PREFIXO}-pay-pix-${sufixo}`,
        amountCents: 4990,
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
        maxUsers: 1,
        analysesQuota: 20,
        analysesUsed: 3,
        extraAnalyses: 5,
      },
    });
  }

  function estorno(event: string, idDaCobranca: string, recorrencia: string) {
    return {
      event,
      payment: {
        id: idDaCobranca,
        customer: "cus_boleto_teste",
        subscription: recorrencia,
        value: 49.9,
        billingType: "BOLETO",
        externalReference: `plano:${PREFIXO}-mensal:user:${userId}`,
      },
    };
  }

  it("NÃO encerra a assinatura paga nem bloqueia o saldo dela", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const paga = await assinaturaPagaPorPix("estorno");

    await processAsaasEvent(
      estorno("PAYMENT_REFUNDED", `${PREFIXO}-pay-devolvido-outra`, "sub_test_boleto_antiga"),
    );

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: paga.id } });
    // ESTORNADA recusa o login: o cliente ficaria fora do ar por um ciclo já encerrado.
    expect(depois.status).toBe("ATIVA");
    expect(depois.canceledAt).toBeNull();
    expect(depois.canceledReason).toBeNull();
    /**
     * O bloqueio de saldo é feito zerando o extra e igualando o usado à cota. Os números
     * originais têm de continuar de pé, senão o cliente perde os créditos que pagou.
     */
    expect(depois.analysesUsed).toBe(3);
    expect(depois.extraAnalyses).toBe(5);
  });

  /**
   * A CONTESTAÇÃO é o caso mais provável de chegar sobre cobrança antiga — e também é
   * classificada como estorno, então percorria o mesmo caminho destrutivo.
   */
  it("contestação de cobrança antiga também não derruba o contrato em vigor", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const paga = await assinaturaPagaPorPix("contestado");

    await processAsaasEvent(
      estorno("PAYMENT_CHARGEBACK_REQUESTED", `${PREFIXO}-pay-contestado-outra`, "sub_test_boleto_antiga_2"),
    );

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: paga.id } });
    expect(depois.status).toBe("ATIVA");
    expect(depois.extraAnalyses).toBe(5);
  });

  it("registra a devolução e chama uma pessoa para decidir", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const paga = await assinaturaPagaPorPix("registrado");
    const idDaCobranca = `${PREFIXO}-pay-registrado-outra`;

    const r = await processAsaasEvent(estorno("PAYMENT_REFUNDED", idDaCobranca, "sub_test_boleto_antiga_3"));

    // Dinheiro que voltou não pode ficar invisível: entra no extrato como estornado.
    const linha = await prisma.payment.findFirstOrThrow({
      where: { externalId: idDaCobranca, status: "ESTORNADO" },
    });
    expect(linha.subscriptionId).toBe(paga.id);
    expect(linha.amountCents).toBe(4990);

    /**
     * E o caso vai para uma pessoa: decidir se o acesso deve cair depende de saber POR QUE o
     * dinheiro voltou (contestação ou cortesia), e o evento não diz.
     */
    const registro = await prisma.auditLog.findFirstOrThrow({
      where: {
        action: "asaas.estorno_de_outro_contrato",
        metadata: { path: ["pagamento"], equals: idDaCobranca },
      },
    });
    expect((registro.metadata as Record<string, unknown>).recorrenciaEmVigor).toBe(paga.externalRef);
    expect(r.action).toBe("estorno");
  });

  it("o par de eventos de estorno gera UM alerta, não dois", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    await assinaturaPagaPorPix("repetido");
    const idDaCobranca = `${PREFIXO}-pay-repetido-outra`;

    await processAsaasEvent(estorno("PAYMENT_REFUNDED", idDaCobranca, "sub_test_boleto_antiga_4"));
    await processAsaasEvent(estorno("PAYMENT_REFUNDED", idDaCobranca, "sub_test_boleto_antiga_4"));

    expect(
      await prisma.auditLog.count({
        where: {
          action: "asaas.estorno_de_outro_contrato",
          metadata: { path: ["pagamento"], equals: idDaCobranca },
        },
      }),
    ).toBe(1);
  });

  /**
   * ⚠️ O guarda não pode engolir o estorno LEGÍTIMO.
   *
   * Um guarda largo demais aqui seria pior que o defeito: devolução da cobrança que paga o
   * contrato atual TEM de encerrá-lo — é o que a Política de Cancelamento §6 publica.
   */
  it("a devolução da cobrança DESTE contrato continua encerrando a assinatura", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const propria = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "ATIVA",
        provider: "ASAAS",
        // Recorrência de boleto: é ELA que o evento vai nomear.
        externalRef: "sub_test_boleto_em_vigor",
        amountCents: 4990,
        nextRenewalAt: new Date(Date.now() + 20 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
        maxUsers: 1,
        analysesQuota: 20,
        analysesUsed: 3,
        extraAnalyses: 5,
      },
    });

    await processAsaasEvent(
      estorno("PAYMENT_REFUNDED", `${PREFIXO}-pay-devolvido-proprio`, "sub_test_boleto_em_vigor"),
    );

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: propria.id } });
    expect(depois.status).toBe("ESTORNADA");
    // Saldo bloqueado: o dinheiro voltou, então o crédito que ele comprou não vale mais.
    expect(depois.extraAnalyses).toBe(0);
    expect(depois.analysesUsed).toBe(depois.analysesQuota);
  });
});

/**
 * A ORDEM das vias de busca — a causa raiz das três contaminações.
 *
 * `acharSub` tinha a via LARGA na frente: pela referência da compra chega-se à CONTA e, da
 * conta, à assinatura MAIS RECENTE, qualquer que seja a recorrência dela. A via PRECISA — a
 * recorrência que o próprio evento nomeia — só era consultada quando a larga não achava
 * nada, ou seja, quase nunca.
 *
 * Este teste é o único que o guarda de recorrência NÃO consegue mascarar, e é por isso que
 * ele existe. Com a ordem antiga o guarda salva a assinatura errada de ser derrubada, mas o
 * evento também deixa de agir sobre a CERTA: a cobrança vence, e a assinatura que era dela
 * continua ATIVA como se estivesse em dia.
 */
describe("qual assinatura o evento encontra", () => {
  it("acha a assinatura da PRÓPRIA recorrência, não a mais recente da conta", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));

    // Duas contratações na mesma conta. A data é explícita para "mais recente" não depender
    // de dois `createdAt` gravados no mesmo milissegundo.
    const antiga = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "ATIVA",
        provider: "ASAAS",
        externalRef: "sub_test_boleto_busca_antiga",
        amountCents: 4990,
        nextRenewalAt: new Date(Date.now() + 5 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000),
        createdAt: new Date(Date.now() - 60 * 86_400_000),
        maxUsers: 1,
        analysesQuota: 20,
      },
    });
    const recente = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "ATIVA",
        provider: "ASAAS",
        externalRef: "sub_test_boleto_busca_recente",
        amountCents: 4990,
        nextRenewalAt: new Date(Date.now() + 25 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 25 * 86_400_000),
        maxUsers: 1,
        analysesQuota: 20,
      },
    });

    // A cobrança vencida é da recorrência ANTIGA, e a referência aponta para a conta —
    // que é exatamente a combinação que fazia a via larga responder primeiro.
    await processAsaasEvent({
      event: "PAYMENT_OVERDUE",
      payment: {
        id: `${PREFIXO}-pay-busca-antiga`,
        customer: "cus_boleto_teste",
        subscription: "sub_test_boleto_busca_antiga",
        value: 49.9,
        billingType: "BOLETO",
        status: "OVERDUE",
        externalReference: `plano:${PREFIXO}-mensal:user:${userId}`,
      },
    });

    // A que atrasou é a que fica inadimplente.
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: antiga.id } })).status).toBe("INADIMPLENTE");
    // E a outra não é tocada.
    const outra = await prisma.subscription.findUniqueOrThrow({ where: { id: recente.id } });
    expect(outra.status).toBe("ATIVA");
    expect(outra.canceledReason).toBeNull();
    expect(outra.graceUntil).toBeNull();
  });
});

describe("pagamento confirmado do boleto", () => {
  function evento(event: string, extra: Partial<Record<string, unknown>> = {}) {
    return {
      event,
      payment: {
        id: `${PREFIXO}-pay-1`,
        customer: "cus_boleto_teste",
        subscription: SUB_ASAAS,
        value: 49.9,
        billingType: "BOLETO",
        status: "RECEIVED",
        externalReference: `plano:${PREFIXO}-mensal:user:${userId}`,
        ...extra,
      },
    };
  }

  it("libera o acesso e PROMETE renovação", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));

    const r = await processAsaasEvent(evento("PAYMENT_RECEIVED"));
    expect(r.action).toBe("aprovado");

    const sub = await prisma.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(sub.status).toBe("ATIVA");
    expect(sub.externalRef).toBe(SUB_ASAAS);
    /**
     * Diferente do PIX: o boleto TEM renovação, porque o Asaas emite a cobrança do
     * ciclo seguinte sozinho. `nextRenewalAt` nulo significa "vale um ciclo e
     * encerra" em toda a aplicação — deixar nulo aqui faria a manutenção diária
     * encerrar a assinatura de quem está pagando em dia.
     */
    expect(sub.nextRenewalAt).not.toBeNull();
    // Plano sem limite: a cota fica em 0 e o saldo responde "ilimitado".
    expect(saldoDe(sub).ilimitado).toBe(true);
  });

  it("resolve o comprador pela assinatura quando o pagamento vem sem referência", async () => {
    /**
     * Verificado em produção: o Asaas NÃO propaga `externalReference` do checkout
     * para o pagamento recorrente. No boleto gravamos a referência na própria
     * assinatura, então o recuo é consultá-la — e é este caminho que a maioria dos
     * pagamentos de boleto vai usar.
     */
    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (String(url).includes(`/subscriptions/${SUB_ASAAS}`)) {
        return new Response(
          JSON.stringify({
            id: SUB_ASAAS,
            externalReference: `plano:${PREFIXO}-mensal:user:${userId}`,
            checkoutSession: null,
            customer: "cus_boleto_teste",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const r = await processAsaasEvent(evento("PAYMENT_RECEIVED", { externalReference: null }));
    expect(r.action).toBe("aprovado");

    const sub = await prisma.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(sub.status).toBe("ATIVA");
  });
});

describe("boleto vencido", () => {
  async function assinaturaAtiva() {
    return prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "ATIVA",
        provider: "ASAAS",
        externalRef: SUB_ASAAS,
        amountCents: 4990,
        analysesQuota: 0,
        currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000),
        nextRenewalAt: new Date(Date.now() + 5 * 86_400_000),
      },
    });
  }

  const atraso = (forma: string) => ({
    event: "PAYMENT_OVERDUE",
    payment: {
      id: `${PREFIXO}-pay-atraso`,
      customer: "cus_boleto_teste",
      subscription: SUB_ASAAS,
      value: 49.9,
      billingType: forma,
      status: "OVERDUE",
      externalReference: null,
    },
  });

  /**
   * ⚠️ A âncora é uma SEGUNDA-FEIRA, e não "hoje". O teste dependia do dia da semana.
   *
   * A asserção era `dias corridos até graceUntil === DIAS_COMPENSACAO_BOLETO`, contados de
   * agora. Só que a janela é de dias ÚTEIS: de quarta a sexta ela atravessa o fim de
   * semana e dá 5 dias corridos, não 3. O teste passava de segunda a terça e falhava nos
   * outros três dias — e não por defeito nenhum do código, que estava certo nos cinco.
   *
   * Teste que muda de resposta conforme o dia em que roda é pior que teste ausente: a
   * falha de quarta manda procurar defeito onde não há, e ninguém confia na suíte depois
   * de duas dessas. Fixando o vencimento numa segunda, segunda + 3 dias úteis é quinta em
   * qualquer semana — e a conta passa a valer todo dia do ano.
   */
  function ultimaSegunda(): string {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    while (d.getDay() !== 1) d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  it("o atraso do boleto marca o motivo e usa a janela de compensação", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const sub = await assinaturaAtiva();
    const vencimento = ultimaSegunda();

    const r = await processAsaasEvent({
      event: "PAYMENT_OVERDUE",
      payment: {
        id: `${PREFIXO}-pay-atraso`,
        customer: "cus_boleto_teste",
        subscription: SUB_ASAAS,
        value: 49.9,
        billingType: "BOLETO",
        status: "OVERDUE",
        dueDate: vencimento,
        externalReference: null,
      },
    });
    expect(r.action).toBe("atraso");

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("INADIMPLENTE");
    /**
     * O motivo gravado é o que diz à manutenção diária que este atraso termina em
     * CANCELAMENTO, e não em nova tentativa de cobrança. Sem ele, o boleto vencido
     * ficaria inadimplente para sempre.
     */
    expect(depois.canceledReason).toBe(MOTIVO_BOLETO_VENCIDO);

    /**
     * Janela curta: o tempo da compensação bancária, contado do VENCIMENTO em dias úteis.
     * Data cheia, e não contagem de dias — é o que separa esta janela da tolerância
     * corrida de inadimplência, que numa quarta-feira daria o mesmo número de dias.
     *
     * A soma é reimplementada aqui de propósito, em vez de importar `somarDiasUteis`:
     * chamar a mesma função que está sendo medida provaria só que ela é igual a si mesma.
     * E ela caminha os dias em vez de somar N corridos, para a conta continuar valendo se
     * a constante subir para além de uma semana.
     */
    const esperado = new Date(`${vencimento}T12:00:00.000Z`);
    for (let restantes = DIAS_COMPENSACAO_BOLETO; restantes > 0; ) {
      esperado.setUTCDate(esperado.getUTCDate() + 1);
      if (esperado.getUTCDay() !== 0 && esperado.getUTCDay() !== 6) restantes--;
    }
    expect(depois.graceUntil!.toISOString().slice(0, 10)).toBe(esperado.toISOString().slice(0, 10));
    // Prazo de boleto nunca vence em fim de semana.
    expect([0, 6]).not.toContain(depois.graceUntil!.getDay());
  });

  /**
   * ── A janela é contada do VENCIMENTO, não da chegada do evento ──────────────
   *
   * É o que a Política publica: prazo contado do vencimento. A diferença é real —
   * webhook atrasado ou reenviado dias depois esticava a janela na mesma medida do
   * atraso, e o prazo praticado deixava de ser o prazo escrito.
   */
  it("a janela parte do vencimento da cobrança, não do instante do evento", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const sub = await assinaturaAtiva();

    // Evento que chega 10 dias depois do vencimento (reenvio, fila atrasada).
    const vencimento = new Date(Date.now() - 10 * 86_400_000);
    await processAsaasEvent({
      event: "PAYMENT_OVERDUE",
      payment: {
        id: `${PREFIXO}-pay-atraso-antigo`,
        customer: "cus_boleto_teste",
        subscription: SUB_ASAAS,
        value: 49.9,
        billingType: "BOLETO",
        status: "OVERDUE",
        dueDate: vencimento.toISOString().slice(0, 10),
        externalReference: null,
      },
    });

    const prazo = (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).graceUntil!;
    // Contado do vencimento, a janela já está no PASSADO: o prazo acabou.
    expect(prazo.getTime()).toBeLessThan(Date.now());
    // Contando da chegada do evento, ela estaria dias no futuro — prazo esticado pelo
    // próprio atraso do provedor.
    expect(prazo.getTime()).toBeLessThan(Date.now() + DIAS_COMPENSACAO_BOLETO * 86_400_000);
  });

  it("sem vencimento no evento, mantém o recuo antigo (conta de agora)", async () => {
    // Melhor um prazo aproximado que nenhum: o campo pode não vir.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const sub = await assinaturaAtiva();

    await processAsaasEvent(atraso("BOLETO"));

    const prazo = (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).graceUntil!;
    expect(prazo.getTime()).toBeGreaterThan(Date.now());
  });

  it("a janela do boleto é contada em dias ÚTEIS, não corridos", async () => {
    /**
     * A janela existe porque boleto pago no vencimento compensa em 1 a 3 dias ÚTEIS.
     * Contada em dias corridos ela desmontava a própria razão de ser: pago numa sexta,
     * o dinheiro chega na quarta — cinco dias corridos —, e três corridos venceriam no
     * domingo, encerrando a assinatura de quem pagou em dia.
     */
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const sub = await assinaturaAtiva();

    await processAsaasEvent(atraso("BOLETO"));
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    const prazo = depois.graceUntil!;

    // Nunca cai em fim de semana, qualquer que seja o dia do evento.
    expect([0, 6]).not.toContain(prazo.getDay());
    // E é pelo menos o número de dias corridos equivalente.
    const corridos = Math.round((prazo.getTime() - Date.now()) / 86_400_000);
    expect(corridos).toBeGreaterThanOrEqual(DIAS_COMPENSACAO_BOLETO);
  });

  it("a tolerância NÃO reinicia a cada cobrança vencida", async () => {
    /**
     * `graceUntil` era reescrito com "agora + prazo" em TODO evento de atraso, e o
     * Asaas manda um por cobrança. Quem nunca pagava ganhava dias novos a cada mês,
     * para sempre: a assinatura nunca era encerrada, seguia contando no MRR e o cliente
     * mantinha créditos que deveriam ter expirado.
     */
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const sub = await assinaturaAtiva();

    await processAsaasEvent(atraso("BOLETO"));
    const primeira = (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).graceUntil!;

    // Segunda cobrança vencida, no mês seguinte: a janela é a MESMA.
    await processAsaasEvent({
      event: "PAYMENT_OVERDUE",
      payment: {
        id: `${PREFIXO}-pay-atraso-2`,
        customer: "cus_boleto_teste",
        subscription: SUB_ASAAS,
        value: 49.9,
        billingType: "BOLETO",
        status: "OVERDUE",
        externalReference: null,
      },
    });
    const segunda = (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).graceUntil!;
    expect(segunda.getTime()).toBe(primeira.getTime());
  });

  it("o atraso do CARTÃO mantém a tolerância maior e não marca cancelamento", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const sub = await assinaturaAtiva();

    await processAsaasEvent(atraso("CREDIT_CARD"));

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("INADIMPLENTE");
    // Cartão recusado tem nova tentativa; não é cancelamento programado.
    expect(depois.canceledReason).toBeNull();
    const dias = Math.round((depois.graceUntil!.getTime() - Date.now()) / 86_400_000);
    expect(dias).toBe(DIAS_TOLERANCIA_INADIMPLENCIA);
    // A regra só faz sentido se os prazos forem diferentes de verdade.
    expect(DIAS_TOLERANCIA_INADIMPLENCIA).toBeGreaterThan(DIAS_COMPENSACAO_BOLETO);
  });

  it("cancela a assinatura quando a janela de compensação passa", async () => {
    const chamadas: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      chamadas.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const sub = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "INADIMPLENTE",
        provider: "ASAAS",
        externalRef: SUB_ASAAS,
        amountCents: 4990,
        analysesQuota: 0,
        canceledReason: MOTIVO_BOLETO_VENCIDO,
        graceUntil: new Date(Date.now() - 86_400_000),
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
        nextRenewalAt: new Date(Date.now() + 25 * 86_400_000),
      },
    });

    const r = await encerrarBoletosVencidos();
    expect(r.encerradas).toBe(1);
    expect(r.recorrenciasNaoCanceladas).toBe(0);

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("CANCELADA");
    expect(depois.canceledAt).not.toBeNull();

    /**
     * A recorrência TEM de ser cancelada no Asaas. Sem isso o provedor seguiria
     * emitindo boleto todo mês para quem já perdeu o acesso — cobrar sem entregar é
     * pior que não cobrar.
     */
    expect(chamadas.some((c) => c.startsWith("DELETE") && c.includes(SUB_ASAAS))).toBe(true);
  });


  /**
   * ── O passo irreversível não se toma às cegas ────────────────────────────────
   *
   * O encerramento faz duas coisas sem volta: cancela a assinatura e APAGA a recorrência
   * no Asaas. Isso era decidido só pelo relógio do nosso banco. Se o webhook de pagamento
   * se perdeu, atrasou além da janela ou falhou ao ser processado, o cliente que PAGOU
   * perdia o acesso e a recorrência — e nada no sistema sabia que havia dinheiro dele lá.
   */
  it("cobrança PAGA no Asaas adia o encerramento — não cancela nem apaga a recorrência", async () => {
    const chamadas: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      chamadas.push(`${init?.method ?? "GET"} ${String(url)}`);
      // O provedor diz que a cobrança do ciclo está paga.
      return new Response(JSON.stringify({ data: [{ status: "RECEIVED" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const sub = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "INADIMPLENTE",
        provider: "ASAAS",
        externalRef: SUB_ASAAS,
        amountCents: 4990,
        analysesQuota: 0,
        canceledReason: MOTIVO_BOLETO_VENCIDO,
        graceUntil: new Date(Date.now() - 86_400_000),
      },
    });

    const r = await encerrarBoletosVencidos();

    expect(r.encerradas).toBe(0);
    expect(r.adiadas).toBe(1);
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("INADIMPLENTE");
    // O que não pode acontecer de jeito nenhum: apagar a recorrência de quem pagou.
    expect(chamadas.some((c) => c.startsWith("DELETE"))).toBe(false);

    const registro = await prisma.auditLog.findFirst({
      where: { action: "subscription.boleto_vencido_adiado", entityId: sub.id },
    });
    expect(registro).not.toBeNull();
  });

  it("consulta que FALHA adia: informação faltando não autoriza passo irreversível", async () => {
    const chamadas: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      chamadas.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response(JSON.stringify({ errors: [{ description: "Serviço indisponível" }] }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    });

    const sub = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "INADIMPLENTE",
        provider: "ASAAS",
        externalRef: SUB_ASAAS,
        amountCents: 4990,
        analysesQuota: 0,
        canceledReason: MOTIVO_BOLETO_VENCIDO,
        graceUntil: new Date(Date.now() - 86_400_000),
      },
    });

    const r = await encerrarBoletosVencidos();

    expect(r.adiadas).toBe(1);
    expect(r.encerradas).toBe(0);
    // Adiar é tentar de novo amanhã; encerrar sem saber não tem volta.
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("INADIMPLENTE");
    expect(chamadas.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("não encerra antes de a janela passar", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const sub = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "INADIMPLENTE",
        provider: "ASAAS",
        externalRef: SUB_ASAAS,
        amountCents: 4990,
        analysesQuota: 0,
        canceledReason: MOTIVO_BOLETO_VENCIDO,
        // Ainda dentro do prazo de compensação: pode ser alguém que pagou no dia do
        // vencimento e o banco ainda não confirmou.
        graceUntil: new Date(Date.now() + 2 * 86_400_000),
      },
    });

    const r = await encerrarBoletosVencidos();
    expect(r.encerradas).toBe(0);

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("INADIMPLENTE");
  });

  it("não toca em inadimplência de cartão", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const sub = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "INADIMPLENTE",
        provider: "ASAAS",
        externalRef: SUB_ASAAS,
        amountCents: 4990,
        analysesQuota: 0,
        // Sem o motivo do boleto: é cartão recusado, e o Asaas ainda vai tentar de
        // novo. Cancelar aqui mataria assinatura que ia se resolver sozinha.
        canceledReason: null,
        graceUntil: new Date(Date.now() - 10 * 86_400_000),
      },
    });

    const r = await encerrarBoletosVencidos();
    expect(r.encerradas).toBe(0);

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("INADIMPLENTE");
  });

  it("rodar duas vezes no mesmo dia não cancela de novo", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId,
        status: "INADIMPLENTE",
        provider: "ASAAS",
        externalRef: SUB_ASAAS,
        amountCents: 4990,
        analysesQuota: 0,
        canceledReason: MOTIVO_BOLETO_VENCIDO,
        graceUntil: new Date(Date.now() - 86_400_000),
      },
    });

    expect((await encerrarBoletosVencidos()).encerradas).toBe(1);
    // A manutenção roda todo dia; a segunda passada não pode achar nada.
    expect((await encerrarBoletosVencidos()).encerradas).toBe(0);
  });
});
