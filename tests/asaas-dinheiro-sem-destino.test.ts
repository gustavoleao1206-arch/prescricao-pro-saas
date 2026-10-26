import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Dinheiro que entra e não tem destino, e cobrança que chega depois do cancelamento.
 *
 * ── Os dois defeitos travados aqui ────────────────────────────────────────────
 *
 * 1. PAGAMENTO SEM DESTINO. Havia oito saídas do webhook em que um pagamento
 *    APROVADO era descartado: conta apagada, plano fora do catálogo, recorrência do
 *    Asaas sem vínculo local, evento sem referência, upgrade e crédito avulso pagos
 *    por quem não tem assinatura. Todas devolviam 200 e no máximo uma linha em
 *    SecurityEvent. O dinheiro saía da conta do cliente e não existia em lugar
 *    nenhum do sistema: nem na lista de pagamentos, nem em chamado, nem em e-mail.
 *
 * 2. RESSURREIÇÃO DA ASSINATURA CANCELADA. O caminho de renovação gravava
 *    `status: "ATIVA"` sem olhar POR QUE a assinatura estava cancelada. Somado ao
 *    cancelamento do painel, que não falava com o Asaas, formava um laço: o admin
 *    cancelava, o cartão seguia sendo debitado, e cada débito reativava a assinatura
 *    com os créditos do ciclo — dando ao erro a aparência de serviço contratado.
 *
 * A distinção que sustenta o conserto: cancelamento por FALTA DE PAGAMENTO segue
 * reativando (ali o dinheiro que chega é o cliente pagando o atraso), cancelamento A
 * PEDIDO não reativa nunca. O último teste deste arquivo protege o caso legítimo,
 * porque consertar o primeiro sem ele quebraria o boleto pago com atraso.
 */

process.env.ASAAS_API_KEY = "chave-de-teste-nao-vai-para-a-rede";
process.env.ASAAS_ENV = "sandbox";

const estado = vi.hoisted(() => ({ adminId: "" }));

/**
 * A rota do painel exige ADMIN autenticado. Só a autenticação é substituída — a
 * regra de negócio testada (falar com o Asaas ao cancelar) permanece a real.
 */
vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    requireRole: async () => ({ id: estado.adminId, role: "ADMIN", email: "admin@teste.local" }),
  };
});

const {
  processAsaasEvent,
  cancelarRecorrencia,
  ehRecorrencia,
  canceladaAPedido,
  pedidoDeParada,
  MOTIVO_CANCELAMENTO_ADMIN,
  MOTIVO_CANCELAMENTO_CLIENTE,
  MOTIVO_BOLETO_VENCIDO,
} = await import("../src/lib/asaas");
const { PATCH } = await import("../src/app/api/admin/assinaturas/[id]/route");
const { POST: RESOLVER } = await import("../src/app/api/admin/pagamentos/[id]/resolver/route");
const { saldoDe } = await import("../src/lib/credits");

const prisma = new PrismaClient();
const PREFIXO = "test-sem-destino";

let userId = "";
let orgId = "";
let planId = "";

/** Chamadas HTTP que o código TENTOU fazer ao Asaas. */
function capturarAsaas(resposta: { status: number; corpo?: unknown } = { status: 200 }) {
  const chamadas: { metodo: string; url: string }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    chamadas.push({ metodo: String(init?.method ?? "GET"), url: String(url) });
    return new Response(JSON.stringify(resposta.corpo ?? { deleted: true }), {
      status: resposta.status,
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
  // Os pagamentos órfãos não têm assinatura: a cascata não os alcança.
  await prisma.payment.deleteMany({ where: { externalId: { startsWith: PREFIXO } } });
  /**
   * Os eventos de segurança deste arquivo, e só eles.
   *
   * A versão anterior filtrava por `metadata.teste`, uma chave que NUNCA foi gravada:
   * não apagava nada, e os eventos acumulavam entre execuções. O efeito foi um teste
   * que passava sozinho e falhava na segunda rodada — pior que falhar sempre, porque
   * parece defeito de outro lugar. O id do pagamento carrega o prefixo do teste, então
   * é por ele que se apaga, sem tocar nos eventos dos outros arquivos.
   */
  await prisma.securityEvent.deleteMany({
    where: { metadata: { path: ["paymentId"], string_starts_with: PREFIXO } },
  });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

beforeAll(async () => {
  await limpar();
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-mensal`,
      name: "Mensal (sem destino)",
      priceCents: 4990,
      period: "MENSAL",
      monthlyAnalyses: 20,
      maxUsers: 1,
    },
  });
  planId = plano.id;

  const admin = await prisma.user.create({
    data: { email: `${PREFIXO}-admin@exemplo.local`, name: "Admin", passwordHash: "x", role: "ADMIN" },
  });
  estado.adminId = admin.id;

  const user = await prisma.user.create({
    data: { email: `${PREFIXO}-cliente@exemplo.local`, name: "Cliente", passwordHash: "x", role: "CLIENTE" },
  });
  userId = user.id;
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org`, ownerId: user.id } });
  orgId = org.id;
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id, orgRole: "OWNER" } });
});

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  await prisma.subscription.deleteMany({ where: { organizationId: orgId } });
  await prisma.payment.deleteMany({ where: { externalId: { startsWith: PREFIXO } } });
});

/** Assinatura já existente, no estado que o teste precisa. */
async function criarAssinatura(dados: {
  status: "ATIVA" | "CANCELADA";
  externalRef: string;
  canceledReason?: string;
  /**
   * Grava `canceledByRequestAt`. É este campo — e não o status nem o texto do motivo —
   * que registra o pedido de parada, justamente porque quatro caminhos do webhook
   * reescrevem os outros dois e desarmavam a garantia.
   */
  pedidoDeParada?: boolean;
  /** Data do pedido, para testar a contratação NOVA depois dele. */
  pedidoEm?: Date;
}) {
  const cancelamento = dados.pedidoEm ?? new Date();
  return prisma.subscription.create({
    data: {
      organizationId: orgId,
      planId,
      status: dados.status,
      provider: "ASAAS",
      externalRef: dados.externalRef,
      amountCents: 4990,
      currentPeriodEnd: new Date(Date.now() + 10 * 86400000),
      nextRenewalAt: dados.status === "ATIVA" ? new Date(Date.now() + 10 * 86400000) : null,
      maxUsers: 1,
      analysesQuota: 20,
      analysesUsed: 20,
      ...(dados.canceledReason ? { canceledAt: cancelamento, canceledReason: dados.canceledReason } : {}),
      ...(dados.pedidoDeParada ? { canceledByRequestAt: cancelamento } : {}),
    },
  });
}

/** Encerramento manual do caso, pela tela de pendências. */
function resolverPendencia(id: string, corpo: { destino: string; motivo: string }) {
  return RESOLVER(
    new Request("http://localhost/api/admin/pagamentos/x/resolver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    }) as never,
    { params: Promise.resolve({ id }) },
  );
}

/**
 * Alertas gravados PARA ESTA COBRANÇA.
 *
 * Contar `securityEvent` por tipo, na tabela inteira, é armadilha: a suíte roda os
 * arquivos em paralelo sobre o mesmo banco, e outro teste criando um evento do mesmo
 * tipo fazia a contagem subir sozinha. Filtrando pelo id do pagamento no metadata, o
 * teste passa a provar o que diz.
 */
async function alertasDe(tipo: string, paymentId: string): Promise<number> {
  return prisma.securityEvent.count({
    where: { type: tipo, metadata: { path: ["paymentId"], equals: paymentId } },
  });
}

function eventoAprovado(id: string, extra: Record<string, unknown> = {}) {
  return {
    event: "PAYMENT_CONFIRMED",
    payment: { id, value: 49.9, billingType: "CREDIT_CARD", status: "CONFIRMED", ...extra },
  };
}

// ---------------------------------------------------------------------------
// 1. Dinheiro que entra sem conta identificável
// ---------------------------------------------------------------------------

describe("pagamento que entra sem destino", () => {
  it("grava a quantia como PENDENTE em vez de descartá-la", async () => {
    const r = await processAsaasEvent(eventoAprovado(`${PREFIXO}-orfao-1`));

    expect(r.action).toBe("ignorado");
    const registro = await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-orfao-1` } });
    expect(registro).not.toBeNull();
    expect(registro!.status).toBe("PENDENTE");
    // Sem assinatura: é exatamente o que faz a quantia aparecer como "não identificada".
    expect(registro!.subscriptionId).toBeNull();
    expect(registro!.amountCents).toBe(4990);
  });

  it("não conta como receita: o status não é APROVADO", async () => {
    await processAsaasEvent(eventoAprovado(`${PREFIXO}-orfao-2`));
    const aprovados = await prisma.payment.count({
      where: { externalId: `${PREFIXO}-orfao-2`, status: "APROVADO" },
    });
    expect(aprovados).toBe(0);
  });

  it("registra o evento de segurança que o painel conta", async () => {
    await processAsaasEvent(eventoAprovado(`${PREFIXO}-orfao-3`));
    expect(await alertasDe("asaas_dinheiro_sem_destino", `${PREFIXO}-orfao-3`)).toBe(1);
  });

  it("o par CONFIRMED→RECEIVED do cartão não duplica registro nem alerta", async () => {
    await processAsaasEvent(eventoAprovado(`${PREFIXO}-orfao-4`));
    await processAsaasEvent({
      event: "PAYMENT_RECEIVED",
      payment: { id: `${PREFIXO}-orfao-4`, value: 49.9, billingType: "CREDIT_CARD" },
    });

    const registros = await prisma.payment.count({ where: { externalId: `${PREFIXO}-orfao-4` } });
    expect(registros).toBe(1);
    // Um alerta por cobrança órfã. Dois e-mails por cobrança ensinam a ignorar o aviso.
    expect(await alertasDe("asaas_dinheiro_sem_destino", `${PREFIXO}-orfao-4`)).toBe(1);
  });

  it("conta do externalReference apagada: a quantia continua existindo", async () => {
    const r = await processAsaasEvent(
      eventoAprovado(`${PREFIXO}-orfao-5`, {
        externalReference: `plano:${PREFIXO}-mensal:user:conta-que-nao-existe`,
      }),
    );
    expect(r.action).toBe("ignorado");
    const registro = await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-orfao-5` } });
    expect(registro?.status).toBe("PENDENTE");
  });

  it("crédito avulso comprado por quem não tem assinatura não é descartado", async () => {
    await prisma.creditPack.upsert({
      where: { slug: `${PREFIXO}-avulso` },
      create: { slug: `${PREFIXO}-avulso`, name: "Avulso (teste)", credits: 1, priceCents: 500, validityDays: 90 },
      update: {},
    });
    // A conta existe e NÃO tem assinatura: o saldo não tem onde morar.
    const semAssinatura = await prisma.user.create({
      data: { email: `${PREFIXO}-sem-plano@exemplo.local`, name: "Sem plano", passwordHash: "x", role: "CLIENTE" },
    });

    const r = await processAsaasEvent(
      eventoAprovado(`${PREFIXO}-orfao-6`, {
        value: 5,
        externalReference: `pacote:${PREFIXO}-avulso:user:${semAssinatura.id}`,
      }),
    );

    expect(r.action).toBe("ignorado");
    const registro = await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-orfao-6` } });
    expect(registro?.status).toBe("PENDENTE");
    expect(registro?.amountCents).toBe(500);

    await prisma.creditPack.deleteMany({ where: { slug: `${PREFIXO}-avulso` } });
  });

  it("recorrência do Asaas sem vínculo local: registra em vez de ignorar", async () => {
    const r = await processAsaasEvent(
      eventoAprovado(`${PREFIXO}-orfao-7`, { subscription: "sub_que_nunca_foi_vinculada" }),
    );
    expect(r.action).toBe("ignorado");
    const registro = await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-orfao-7` } });
    expect(registro?.status).toBe("PENDENTE");
  });
});

// ---------------------------------------------------------------------------
// 2. Cobrança que chega depois do cancelamento
// ---------------------------------------------------------------------------

describe("cobrança recebida depois do cancelamento", () => {
  it("cancelada a pedido do CLIENTE: não reativa a assinatura", async () => {
    const sub = await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_cancelada_pelo_cliente",
      canceledReason: MOTIVO_CANCELAMENTO_CLIENTE,
      pedidoDeParada: true,
    });

    const r = await processAsaasEvent(
      eventoAprovado(`${PREFIXO}-pos-cancel-1`, { subscription: "sub_cancelada_pelo_cliente" }),
    );

    expect(r.action).toBe("ignorado");
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("CANCELADA");
    // A data de renovação não pode ser reescrita: ela é a promessa de nova cobrança.
    expect(depois.nextRenewalAt).toBeNull();
  });

  it("cancelada pelo ADMIN: não reativa e não libera crédito nenhum", async () => {
    const sub = await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_cancelada_pelo_admin",
      canceledReason: MOTIVO_CANCELAMENTO_ADMIN,
      pedidoDeParada: true,
    });
    // A cota está esgotada (analysesUsed = analysesQuota): saldo zero antes do evento.
    expect(saldoDe(sub).total).toBe(0);

    await processAsaasEvent(eventoAprovado(`${PREFIXO}-pos-cancel-2`, { subscription: "sub_cancelada_pelo_admin" }));

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("CANCELADA");
    // Liberar os 20 créditos daria à cobrança indevida a aparência de serviço contratado.
    expect(saldoDe(depois).total).toBe(0);
  });

  it("a quantia fica registrada como PENDENTE, ligada à assinatura, para devolução", async () => {
    const sub = await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_para_devolver",
      canceledReason: MOTIVO_CANCELAMENTO_CLIENTE,
      pedidoDeParada: true,
    });

    await processAsaasEvent(eventoAprovado(`${PREFIXO}-pos-cancel-3`, { subscription: "sub_para_devolver" }));

    const registro = await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-pos-cancel-3` } });
    expect(registro?.status).toBe("PENDENTE");
    expect(registro?.subscriptionId).toBe(sub.id);
  });

  it("alerta a operação e registra na auditoria", async () => {
    await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_alerta",
      canceledReason: MOTIVO_CANCELAMENTO_CLIENTE,
      pedidoDeParada: true,
    });

    await processAsaasEvent(eventoAprovado(`${PREFIXO}-pos-cancel-4`, { subscription: "sub_alerta" }));

    expect(await alertasDe("asaas_cobranca_apos_cancelamento", `${PREFIXO}-pos-cancel-4`)).toBe(1);
    const auditoria = await prisma.auditLog.findFirst({ where: { action: "asaas.cobranca_apos_cancelamento" } });
    expect(auditoria).not.toBeNull();
  });

  /**
   * O contrapeso. Encerrar por boleto vencido é cancelamento por FALTA DE
   * PAGAMENTO: o dinheiro que chega depois é o cliente pagando com atraso, e a
   * compensação bancária leva dias. Recusar aqui tiraria o serviço de quem pagou.
   */
  it("cancelada por BOLETO VENCIDO: o pagamento atrasado reativa e libera a cota", async () => {
    const sub = await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_boleto_atrasado",
      canceledReason: MOTIVO_BOLETO_VENCIDO,
    });

    const r = await processAsaasEvent({
      event: "PAYMENT_RECEIVED",
      payment: { id: `${PREFIXO}-boleto-pago`, value: 49.9, billingType: "BOLETO", subscription: "sub_boleto_atrasado" },
    });

    expect(r.action).toBe("aprovado");
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("ATIVA");
    expect(saldoDe(depois).total).toBe(20);
    const registro = await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-boleto-pago` } });
    expect(registro?.status).toBe("APROVADO");

    /**
     * ⚠️ E a recorrência não existe mais.
     *
     * O encerramento por boleto vencido APAGA a recorrência no Asaas — é o certo, senão o
     * provedor seguiria emitindo boleto para quem perdeu o acesso. Mas o dinheiro pode
     * chegar depois, e aí a reativação devolve o acesso deste ciclo e mais nada: sem
     * recorrência, a assinatura pararia sozinha no fim do ciclo, em silêncio, sem que nem
     * o cliente (que acabou de pagar) nem nós soubéssemos.
     */
    const alerta = await prisma.securityEvent.findFirst({
      where: {
        type: "asaas_boleto_pago_apos_encerramento",
        metadata: { path: ["pagamento"], equals: `${PREFIXO}-boleto-pago` },
      },
    });
    expect(alerta).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Cancelar no painel tem de falar com o Asaas
// ---------------------------------------------------------------------------

/** A rota recebe o corpo por `req.json()`; um Request comum basta. */
function pedido(action: string) {
  return new Request("http://localhost/api/admin/assinaturas/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  }) as never;
}

describe("cancelamento pelo painel do administrador", () => {
  it("manda o Asaas encerrar a recorrência — era só o banco local", async () => {
    const sub = await criarAssinatura({ status: "ATIVA", externalRef: "sub_do_painel" });
    const chamadas = capturarAsaas();

    const res = await PATCH(pedido("cancelar"), { params: Promise.resolve({ id: sub.id }) });
    const corpo = await res.json();

    expect(res.status).toBe(200);
    const exclusao = chamadas.find((c) => c.metodo === "DELETE");
    expect(exclusao?.url).toContain("/subscriptions/sub_do_painel");
    expect(corpo.data.cobrancaInterrompida).toBe(true);

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("CANCELADA");
    // O motivo é lido depois, para decidir o destino do dinheiro que chegar atrasado.
    expect(depois.canceledReason).toBe(MOTIVO_CANCELAMENTO_ADMIN);
  });

  it("falha do gateway não perde o cancelamento, e a resposta não mente", async () => {
    const sub = await criarAssinatura({ status: "ATIVA", externalRef: "sub_gateway_fora" });
    capturarAsaas({ status: 503, corpo: { errors: [{ description: "Serviço indisponível" }] } });

    const res = await PATCH(pedido("cancelar"), { params: Promise.resolve({ id: sub.id }) });
    const corpo = await res.json();

    // O pedido do administrador não depende da disponibilidade do provedor…
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("CANCELADA");
    // …mas a cobrança segue viva, e isso tem de estar dito.
    expect(corpo.data.cobrancaInterrompida).toBe(false);
    expect(corpo.data.message).toContain("ATENÇÃO");
    const evento = await prisma.securityEvent.findFirst({
      where: { type: "asaas_cancelamento_nao_efetivado" },
      orderBy: { createdAt: "desc" },
    });
    expect(evento).not.toBeNull();
  });

  it("PIX não gera alarme falso: não há recorrência a encerrar", async () => {
    // Em cobrança única o externalRef guarda o id do PAGAMENTO, não de uma assinatura.
    const sub = await criarAssinatura({ status: "ATIVA", externalRef: "pay_cobranca_unica_pix" });
    const chamadas = capturarAsaas();

    const res = await PATCH(pedido("cancelar"), { params: Promise.resolve({ id: sub.id }) });
    const corpo = await res.json();

    expect(chamadas).toHaveLength(0);
    expect(corpo.data.cobrancaInterrompida).toBe(true);
    expect(corpo.data.message).toContain("Não havia cobrança recorrente");
  });

  /**
   * ── O cliente estornado ficava sem saída nenhuma ─────────────────────────────
   *
   * Recebido um estorno, a conta vai para ESTORNADA: acesso bloqueado, créditos
   * bloqueados — e o LOGIN é recusado. Ele não consegue entrar para clicar em "cancelar",
   * e "Cancelar" pelo painel é (corretamente) recusado durante a revisão, porque
   * destruiria o estado dela e o prazo que a Política promete. Enquanto isso a recorrência
   * seguia viva, debitando todo mês.
   *
   * "Interromper cobrança" faz só isso: para a cobrança e não toca em nada mais.
   */
  it("interrompe a cobrança de quem está em revisão sem destruir a revisão", async () => {
    const sub = await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_em_revisao",
      canceledReason: "Estorno (PAYMENT_REFUNDED)",
    });
    // Estado real da revisão: ESTORNADA, com a data que é o relógio do prazo.
    const canceladoEm = new Date(Date.now() - 3 * 86400000);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: "ESTORNADA", canceledAt: canceladoEm },
    });
    const chamadas = capturarAsaas();

    const res = await PATCH(pedido("interromper-cobranca"), { params: Promise.resolve({ id: sub.id }) });
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.cobrancaInterrompida).toBe(true);
    expect(chamadas.some((c) => c.metodo === "DELETE" && c.url.includes("sub_em_revisao"))).toBe(true);

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    // A revisão continua inteira: estado, motivo e RELÓGIO DO PRAZO intocados.
    expect(depois.status).toBe("ESTORNADA");
    expect(depois.canceledReason).toBe("Estorno (PAYMENT_REFUNDED)");
    expect(depois.canceledAt?.getTime()).toBe(canceladoEm.getTime());
    // E o pedido de parada fica registrado: dinheiro que chegar depois é devolvido.
    expect(depois.canceledByRequestAt).not.toBeNull();
    expect(depois.nextRenewalAt).toBeNull();
  });

  it("cancelar em revisão continua recusado — quem para a cobrança é a ação própria", async () => {
    const sub = await criarAssinatura({ status: "CANCELADA", externalRef: "sub_revisao_2" });
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: "ESTORNADA" } });
    capturarAsaas();

    const res = await PATCH(pedido("cancelar"), { params: Promise.resolve({ id: sub.id }) });

    // Cancelar apagaria o prazo da revisão; a recusa é proteção do assinante.
    expect(res.status).toBe(409);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("ESTORNADA");
  });

  it("liberar acesso avisa que a cobrança automática não é recriada", async () => {
    const sub = await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_liberada",
      canceledReason: MOTIVO_CANCELAMENTO_ADMIN,
      pedidoDeParada: true,
    });
    capturarAsaas();

    const res = await PATCH(pedido("reativar"), { params: Promise.resolve({ id: sub.id }) });
    const corpo = await res.json();

    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("ATIVA");
    expect(corpo.data.message).toContain("NÃO é recriada");
  });
});

// ---------------------------------------------------------------------------
// 3b. Os caminhos por onde a garantia era contornada
// ---------------------------------------------------------------------------

/**
 * A primeira versão desta garantia vivia dentro do caminho de RENOVAÇÃO, e por isso
 * cobria quase nada. Estes testes usam os payloads REAIS que passavam por fora dela —
 * e que nenhum teste exercitava.
 */
describe("caminhos que contornavam a garantia", () => {
  it("BOLETO com externalReference: o boleto do ciclo pago com atraso NÃO ressuscita", async () => {
    const sub = await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_boleto_cancelado",
      canceledReason: MOTIVO_CANCELAMENTO_CLIENTE,
      pedidoDeParada: true,
    });

    /**
     * `criarAssinaturaBoleto` grava `externalReference` na ASSINATURA do Asaas, e ele
     * viaja em toda cobrança dela. Era isso que fazia o boleto entrar sempre pelo
     * caminho de primeira compra, onde não havia guarda nenhuma.
     */
    const r = await processAsaasEvent({
      event: "PAYMENT_RECEIVED",
      payment: {
        id: `${PREFIXO}-boleto-pos-cancel`,
        subscription: "sub_boleto_cancelado",
        billingType: "BOLETO",
        value: 49.9,
        externalReference: `plano:${PREFIXO}-mensal:user:${userId}`,
      },
    });

    expect(r.action).toBe("ignorado");
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("CANCELADA");
    // O rastro do pedido não pode ser apagado: era o apagamento que desarmava a
    // garantia para todas as cobranças seguintes.
    expect(depois.canceledByRequestAt).not.toBeNull();
    expect(saldoDe(depois).total).toBe(0);
    expect((await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-boleto-pos-cancel` } }))?.status).toBe("PENDENTE");
  });

  it("CARTÃO com checkoutSession: a liquidação tardia NÃO ressuscita", async () => {
    const sessao = `${PREFIXO}-sessao-antiga`;
    await prisma.asaasCheckout.create({
      data: { id: sessao, tipo: "plano", slug: `${PREFIXO}-mensal`, userId },
    });
    const sub = await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_cartao_cancelado",
      canceledReason: MOTIVO_CANCELAMENTO_CLIENTE,
      pedidoDeParada: true,
    });

    // A sessão de checkout foi criada ANTES do pedido de parada: é a mesma contratação.
    const r = await processAsaasEvent({
      event: "PAYMENT_RECEIVED",
      payment: {
        id: `${PREFIXO}-cartao-liquidacao`,
        subscription: "sub_cartao_cancelado",
        checkoutSession: sessao,
        billingType: "CREDIT_CARD",
        value: 49.9,
      },
    });

    expect(r.action).toBe("ignorado");
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("CANCELADA");
    expect(depois.canceledByRequestAt).not.toBeNull();

    await prisma.asaasCheckout.deleteMany({ where: { id: sessao } });
  });

  /**
   * O contrapeso da garantia: quem cancelou e VOLTA por vontade própria tem de ser
   * ativado. A evidência de contratação nova é uma sessão de checkout criada DEPOIS do
   * pedido de parada — nunca o `externalReference`, que chega igual nas duas.
   */
  it("recontratação depois do cancelamento ATIVA normalmente", async () => {
    const ontem = new Date(Date.now() - 86400000);
    const sub = await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_recontratacao",
      canceledReason: MOTIVO_CANCELAMENTO_CLIENTE,
      pedidoDeParada: true,
      pedidoEm: ontem,
    });
    const sessaoNova = `${PREFIXO}-sessao-nova`;
    await prisma.asaasCheckout.create({
      data: { id: sessaoNova, tipo: "plano", slug: `${PREFIXO}-mensal`, userId },
    });

    const r = await processAsaasEvent({
      event: "PAYMENT_CONFIRMED",
      payment: {
        id: `${PREFIXO}-recontratou`,
        subscription: "sub_nova_recorrencia",
        checkoutSession: sessaoNova,
        billingType: "CREDIT_CARD",
        value: 49.9,
      },
    });

    expect(r.action).toBe("aprovado");
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("ATIVA");
    // Recomeça limpo: o pedido de parada anterior não persegue quem voltou.
    expect(depois.canceledByRequestAt).toBeNull();
    expect(saldoDe(depois).total).toBe(20);

    await prisma.asaasCheckout.deleteMany({ where: { id: sessaoNova } });
  });

  it("PAYMENT_OVERDUE não marca de inadimplente quem pediu para parar", async () => {
    const sub = await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_vencida_apos_cancelar",
      canceledReason: MOTIVO_CANCELAMENTO_CLIENTE,
      pedidoDeParada: true,
    });

    const r = await processAsaasEvent({
      event: "PAYMENT_OVERDUE",
      payment: { id: `${PREFIXO}-vencido`, subscription: "sub_vencida_apos_cancelar", billingType: "BOLETO", value: 49.9 },
    });

    expect(r.action).toBe("ignorado");
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    // INADIMPLENTE acusaria o cliente de dever o que ele mandou cancelar — e, na versão
    // anterior, tirava a assinatura de CANCELADA e desarmava a garantia.
    expect(depois.status).toBe("CANCELADA");
    expect(depois.canceledByRequestAt).not.toBeNull();
  });

  it("PAYMENT_DELETED não apaga o motivo do pedido — evento que o nosso DELETE provoca", async () => {
    const sub = await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_delete_do_asaas",
      canceledReason: MOTIVO_CANCELAMENTO_CLIENTE,
      pedidoDeParada: true,
    });

    await processAsaasEvent({
      event: "PAYMENT_DELETED",
      payment: { id: `${PREFIXO}-apagado`, subscription: "sub_delete_do_asaas", value: 49.9 },
    });

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.canceledReason).toBe(MOTIVO_CANCELAMENTO_CLIENTE);
    expect(depois.canceledByRequestAt).not.toBeNull();
  });

  it("upgrade pago depois do cancelamento não rearma a cobrança", async () => {
    const sub = await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_upgrade_apos_cancelar",
      canceledReason: MOTIVO_CANCELAMENTO_ADMIN,
      pedidoDeParada: true,
    });
    const chamadas = capturarAsaas();

    const r = await processAsaasEvent(
      eventoAprovado(`${PREFIXO}-upgrade-pos-cancel`, {
        value: 40,
        externalReference: `upgrade:${PREFIXO}-mensal:user:${userId}`,
      }),
    );

    expect(r.action).toBe("ignorado");
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("CANCELADA");
    expect(depois.nextRenewalAt).toBeNull();
    // Nem PUT de valor, nem nada: a recorrência de assinatura parada não se atualiza.
    expect(chamadas.filter((c) => c.metodo === "PUT")).toHaveLength(0);
  });

  /**
   * O par do cartão são dois eventos do MESMO débito, separados por dias. Cancelar
   * entre um e outro fazia o segundo ser tratado como cobrança indevida — e a operação
   * era mandada devolver receita legítima, já aplicada.
   */
  it("liquidação de cobrança aprovada ANTES do cancelamento não vira dívida", async () => {
    const sub = await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_liquidacao_legitima",
      canceledReason: MOTIVO_CANCELAMENTO_CLIENTE,
      pedidoDeParada: true,
    });
    // O pagamento já havia sido aprovado antes do cancelamento.
    await prisma.payment.create({
      data: {
        subscriptionId: sub.id,
        provider: "ASAAS",
        externalId: `${PREFIXO}-ja-aprovado`,
        status: "APROVADO",
        amountCents: 4990,
        paidAt: new Date(),
      },
    });

    const r = await processAsaasEvent({
      event: "PAYMENT_RECEIVED",
      payment: { id: `${PREFIXO}-ja-aprovado`, subscription: "sub_liquidacao_legitima", billingType: "CREDIT_CARD", value: 49.9 },
    });

    expect(r.action).toBe("ignorado");
    expect(r.message).toContain("ANTES do cancelamento");
    // Nada de PENDENTE: mandar devolver receita legítima é tão grave quanto não devolver
    // a indevida.
    expect(await prisma.payment.count({ where: { externalId: `${PREFIXO}-ja-aprovado`, status: "PENDENTE" } })).toBe(0);
  });

  it("o par CONFIRMED→RECEIVED da cobrança indevida avisa UMA vez", async () => {
    await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_par_indevido",
      canceledReason: MOTIVO_CANCELAMENTO_CLIENTE,
      pedidoDeParada: true,
    });

    await processAsaasEvent(eventoAprovado(`${PREFIXO}-par-indevido`, { subscription: "sub_par_indevido" }));
    await processAsaasEvent({
      event: "PAYMENT_RECEIVED",
      payment: { id: `${PREFIXO}-par-indevido`, subscription: "sub_par_indevido", billingType: "CREDIT_CARD", value: 49.9 },
    });

    // Dois avisos do mesmo débito ensinam a ignorar o aviso — e o cliente receberia
    // duas vezes "vamos devolver".
    expect(await alertasDe("asaas_cobranca_apos_cancelamento", `${PREFIXO}-par-indevido`)).toBe(1);
    expect(await prisma.payment.count({ where: { externalId: `${PREFIXO}-par-indevido` } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. O caso tem de poder ser ENCERRADO
// ---------------------------------------------------------------------------

/**
 * Registrar o dinheiro órfão resolveu metade do problema. A outra metade é a saída:
 * sem ela, a tela de pendências só cresce, e lista que só cresce ninguém lê — o
 * defeito voltaria pela porta dos fundos.
 */
describe("encerramento do caso", () => {
  it("devolução feita no Asaas fecha a linha sozinha, sem criar segundo registro", async () => {
    await processAsaasEvent(eventoAprovado(`${PREFIXO}-fecha-1`));
    expect((await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-fecha-1` } }))?.status).toBe("PENDENTE");

    const r = await processAsaasEvent({
      event: "PAYMENT_REFUNDED",
      payment: { id: `${PREFIXO}-fecha-1`, value: 49.9, billingType: "CREDIT_CARD" },
    });

    expect(r.action).toBe("estorno");
    const registros = await prisma.payment.findMany({ where: { externalId: `${PREFIXO}-fecha-1` } });
    // A MESMA linha muda de estado: dois registros seriam o mesmo dinheiro contado duas vezes.
    expect(registros).toHaveLength(1);
    expect(registros[0]!.status).toBe("ESTORNADO");
  });

  it("devolução PARCIAL não encerra o caso", async () => {
    await processAsaasEvent(eventoAprovado(`${PREFIXO}-fecha-2`));

    await processAsaasEvent({
      event: "PAYMENT_PARTIALLY_REFUNDED",
      payment: { id: `${PREFIXO}-fecha-2`, value: 20, billingType: "CREDIT_CARD" },
    });

    // Parte do dinheiro voltou, parte não: afirmar "encerrado" seria mentira.
    expect((await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-fecha-2` } }))?.status).toBe("PENDENTE");
  });

  /**
   * O caso mais perigoso do arquivo. Devolver a cobrança indevida caía no caminho
   * comum de estorno, que é destrutivo: marcaria a conta como ESTORNADA, bloquearia
   * o saldo e mandaria "assinatura encerrada por estorno" — punindo o cliente pela
   * devolução de uma cobrança que NÓS fizemos por engano.
   */
  it("devolver cobrança indevida NÃO põe o cliente em estorno", async () => {
    const sub = await criarAssinatura({
      status: "CANCELADA",
      externalRef: "sub_devolucao_indevida",
      canceledReason: MOTIVO_CANCELAMENTO_CLIENTE,
      pedidoDeParada: true,
    });
    await processAsaasEvent(eventoAprovado(`${PREFIXO}-fecha-3`, { subscription: "sub_devolucao_indevida" }));

    await processAsaasEvent({
      event: "PAYMENT_REFUNDED",
      payment: { id: `${PREFIXO}-fecha-3`, value: 49.9, billingType: "CREDIT_CARD", subscription: "sub_devolucao_indevida" },
    });

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("CANCELADA");
    expect(depois.status).not.toBe("ESTORNADA");
    expect((await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-fecha-3` } }))?.status).toBe("ESTORNADO");
  });

  it("aplicar à mão encerra o caso e passa a contar como receita", async () => {
    await processAsaasEvent(eventoAprovado(`${PREFIXO}-fecha-4`));
    const pendente = await prisma.payment.findFirstOrThrow({ where: { externalId: `${PREFIXO}-fecha-4` } });

    const res = await resolverPendencia(pendente.id, { destino: "aplicado", motivo: "Pagador identificado por CPF" });
    expect(res.status).toBe(200);

    const depois = await prisma.payment.findUniqueOrThrow({ where: { id: pendente.id } });
    expect(depois.status).toBe("APROVADO");
    expect(depois.paidAt).not.toBeNull();
  });

  it("já registrado em outro lançamento encerra SEM virar receita", async () => {
    await processAsaasEvent(eventoAprovado(`${PREFIXO}-fecha-5`));
    const pendente = await prisma.payment.findFirstOrThrow({ where: { externalId: `${PREFIXO}-fecha-5` } });

    await resolverPendencia(pendente.id, { destino: "duplicado", motivo: "Já lançado pela ativação manual" });

    const depois = await prisma.payment.findUniqueOrThrow({ where: { id: pendente.id } });
    // APROVADO aqui contaria o mesmo dinheiro duas vezes; ESTORNADO afirmaria uma
    // devolução que não houve.
    expect(depois.status).toBe("CANCELADO");
    expect(depois.paidAt).toBeNull();
  });

  it("recusa encerrar duas vezes, e recusa motivo vazio", async () => {
    await processAsaasEvent(eventoAprovado(`${PREFIXO}-fecha-6`));
    const pendente = await prisma.payment.findFirstOrThrow({ where: { externalId: `${PREFIXO}-fecha-6` } });

    expect((await resolverPendencia(pendente.id, { destino: "devolvido", motivo: "ok" })).status).toBe(422);

    await resolverPendencia(pendente.id, { destino: "devolvido", motivo: "Devolvido via painel do Asaas" });
    const segunda = await resolverPendencia(pendente.id, { destino: "aplicado", motivo: "tentativa indevida" });
    expect(segunda.status).toBe(409);
    // O segundo pedido não pode reescrever o desfecho já registrado.
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pendente.id } })).status).toBe("ESTORNADO");
  });

  it("não encerra pagamento que não está pendente", async () => {
    const sub = await criarAssinatura({ status: "ATIVA", externalRef: "sub_receita_normal" });
    const aprovado = await prisma.payment.create({
      data: { subscriptionId: sub.id, provider: "ASAAS", externalId: `${PREFIXO}-aprovado`, status: "APROVADO", amountCents: 4990 },
    });

    const res = await resolverPendencia(aprovado.id, { destino: "devolvido", motivo: "não deveria passar" });
    expect(res.status).toBe(409);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: aprovado.id } })).status).toBe("APROVADO");
  });
});

// ---------------------------------------------------------------------------
// 5. As regras isoladas
// ---------------------------------------------------------------------------

describe("regras de apoio", () => {
  it("só `sub_` é recorrência; `pay_` é cobrança única", () => {
    expect(ehRecorrencia("sub_123")).toBe(true);
    expect(ehRecorrencia("pay_123")).toBe(false);
    expect(ehRecorrencia(null)).toBe(false);
  });

  /**
   * A garantia lê um CAMPO, não o status nem o texto do motivo. Foi a primeira versão
   * que dependia dos dois, e ela se desarmava sozinha: o webhook de atraso trocava o
   * status para INADIMPLENTE, o de exclusão de cobrança trocava o motivo para
   * "Cancelamento via Asaas" (disparado pelo NOSSO próprio DELETE) e a reativação
   * zerava os dois.
   */
  it("o pedido de parada é um campo, não o texto do motivo", () => {
    expect(canceladaAPedido({ canceledByRequestAt: new Date() })).toBe(true);
    expect(canceladaAPedido({ canceledByRequestAt: null })).toBe(false);
  });

  it("pedidoDeParada apaga a promessa de renovação e o downgrade agendado", () => {
    const d = pedidoDeParada(MOTIVO_CANCELAMENTO_CLIENTE);
    expect(d.status).toBe("CANCELADA");
    expect(d.canceledByRequestAt).toBeInstanceOf(Date);
    // Prometer "Próxima cobrança" a quem pediu para parar é a contradição mais visível
    // que a tela do cliente pode ter.
    expect(d.nextRenewalAt).toBeNull();
    expect(d.pendingPlanId).toBeNull();
  });

  it("cancelar cobrança única não vai à rede e não é tratado como falha", async () => {
    const chamadas = capturarAsaas();
    const erro = await cancelarRecorrencia("pay_cobranca_unica", { tipoEvento: "teste" });
    expect(erro).toBeUndefined();
    expect(chamadas).toHaveLength(0);
  });
});
