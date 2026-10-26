import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Reconciliação: a liberação de acesso deixa de depender do webhook CHEGAR.
 *
 * ── O problema ────────────────────────────────────────────────────────────────
 * Todo o acesso do produto era liberado por um gatilho só — o webhook do Asaas batendo
 * na nossa porta —, e gatilho único é ponto único de falha. Este falha de verdade: a fila
 * do Asaas é INTERROMPIDA no primeiro evento que dá erro permanente e não entrega nenhum
 * posterior (aconteceu neste projeto), há deploy no meio da entrega, e há evento não
 * marcado no painel ou token divergente, que recusa em silêncio.
 *
 * O desfecho é sempre o mesmo e é o pior que existe: o cliente pagou e não recebeu. O
 * remédio era humano — alguém percebia e liberava à mão —, então quem pagasse à noite
 * ficava sem acesso até alguém olhar.
 *
 * ── A regra que estes testes travam ───────────────────────────────────────────
 * Asaas confirmou o pagamento? Sistema liberado. Sem pessoa no meio, e pelo MESMO caminho
 * do webhook — nada de regra duplicada, porque regra duplicada é como as duas divergem.
 */

process.env.ASAAS_API_KEY = "chave-de-teste-nao-vai-para-a-rede";
process.env.ASAAS_ENV = "sandbox";

const { reconciliarPagamentos, ACAO_PAGAMENTO_RECUPERADO } = await import("../src/lib/asaas");

const prisma = new PrismaClient();
const PREFIXO = "test-reconc";

let planoId = "";
let userId = "";

/**
 * Lista de cobranças como o Asaas responde: `data` + `hasMore`. A URL é guardada para o
 * teste poder afirmar O QUE foi perguntado — filtro errado devolveria "nada a liberar"
 * com toda a aparência de sucesso.
 */
function simularAsaas(porStatus: Record<string, unknown[]>) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const alvo = String(url);
    urls.push(alvo);
    const status = /status=([A-Z_]+)/.exec(alvo)?.[1] ?? "";
    const offset = Number(/offset=(\d+)/.exec(alvo)?.[1] ?? 0);
    const cobrancas = offset === 0 ? (porStatus[status] ?? []) : [];
    return new Response(JSON.stringify({ data: cobrancas, hasMore: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return urls;
}

function cobranca(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    customer: "cus_reconc",
    value: 49.9,
    billingType: "PIX",
    status: "RECEIVED",
    externalReference: `plano:${PREFIXO}-mensal:user:${userId}`,
    ...extra,
  };
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
  // Pagamento não cascateia com a assinatura: apagar por externalId é o único jeito.
  await prisma.payment.deleteMany({ where: { externalId: { startsWith: PREFIXO } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIXO } } });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
  await prisma.securityEvent.deleteMany({ where: { type: "asaas_pagamento_recuperado" } });
}

beforeAll(limpar);

afterAll(async () => {
  vi.unstubAllGlobals();
  await limpar();
  await prisma.$disconnect();
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  await limpar();
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-mensal`,
      name: "Mensal (reconciliação)",
      priceCents: 4990,
      period: "MENSAL",
      monthlyAnalyses: 20,
      maxUsers: 1,
    },
  });
  planoId = plano.id;
  const user = await prisma.user.create({
    data: { email: `${PREFIXO}-cliente@exemplo.local`, name: "Cliente Reconciliado", role: "CLIENTE", status: "ATIVO" },
  });
  userId = user.id;
});

describe("pagamento confirmado no Asaas que nunca chegou aqui", () => {
  it("libera o acesso sem pessoa no meio", async () => {
    simularAsaas({ RECEIVED: [cobranca(`${PREFIXO}-pay-perdido`)] });

    const r = await reconciliarPagamentos();

    expect(r.falhou).toBe(false);
    expect(r.liberadas).toBe(1);

    /**
     * O que importa não é o contador: é o cliente com acesso. A organização e a
     * assinatura nascem aqui, como nasceriam pelo webhook.
     */
    const org = await prisma.organization.findFirstOrThrow({ where: { ownerId: userId } });
    const sub = await prisma.subscription.findFirstOrThrow({ where: { organizationId: org.id } });
    expect(sub.status).toBe("ATIVA");
    expect(sub.planId).toBe(planoId);
    expect(sub.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
    // E o dinheiro fica registrado, senão a próxima varredura aplicaria de novo.
    expect(
      await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-pay-perdido`, status: "APROVADO" } }),
    ).not.toBeNull();
  });

  it("deixa rastro próprio — é como se responde 'o webhook está entregando?'", async () => {
    simularAsaas({ RECEIVED: [cobranca(`${PREFIXO}-pay-rastro`)] });

    await reconciliarPagamentos();

    /**
     * Sem registro separado, pagamento recuperado ficaria indistinguível de pagamento
     * entregue normalmente — e o defeito de entrega seguiria invisível justamente porque
     * a reconciliação o esconde bem.
     */
    const registro = await prisma.auditLog.findFirstOrThrow({
      where: { action: ACAO_PAGAMENTO_RECUPERADO, entityId: `${PREFIXO}-pay-rastro` },
    });
    expect((registro.metadata as Record<string, unknown>).statusNoAsaas).toBe("RECEIVED");
  });

  it("avisa a operação, porque recuperar pagamento é sintoma de webhook não entregando", async () => {
    simularAsaas({ RECEIVED: [cobranca(`${PREFIXO}-pay-avisa`)] });

    await reconciliarPagamentos();

    const evento = await prisma.securityEvent.findFirstOrThrow({ where: { type: "asaas_pagamento_recuperado" } });
    expect((evento.metadata as Record<string, unknown>).liberadas).toBe(1);
  });

  it("pergunta ao Asaas pelas cobranças PAGAS, com filtro de data", async () => {
    const urls = simularAsaas({});

    await reconciliarPagamentos({ desde: new Date("2026-07-01T12:00:00.000Z") });

    /**
     * Os três estados em que o Asaas considera o dinheiro recebido. Faltando um, o cliente
     * daquele estado nunca seria recuperado — e RECEIVED_IN_CASH é o de quem o próprio dono
     * marcou como pago no painel.
     */
    for (const status of ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]) {
      expect(urls.some((u) => u.includes(`status=${status}`))).toBe(true);
    }
    // A data entra como filtro, senão a varredura leria a conta inteira todo dia.
    expect(urls.every((u) => u.includes("2026-07-01"))).toBe(true);
  });
});

describe("o que já foi tratado não é tocado de novo", () => {
  it("pagamento já registrado é reconhecido e ignorado", async () => {
    // Primeira passada: libera.
    simularAsaas({ RECEIVED: [cobranca(`${PREFIXO}-pay-duas-vezes`)] });
    const primeira = await reconciliarPagamentos();
    expect(primeira.liberadas).toBe(1);

    const org = await prisma.organization.findFirstOrThrow({ where: { ownerId: userId } });
    const antes = await prisma.subscription.findFirstOrThrow({ where: { organizationId: org.id } });

    // Segunda passada, mesma cobrança: nada a fazer.
    simularAsaas({ RECEIVED: [cobranca(`${PREFIXO}-pay-duas-vezes`)] });
    const segunda = await reconciliarPagamentos();

    expect(segunda.liberadas).toBe(0);
    expect(segunda.jaConhecidas).toBe(1);
    /**
     * E o período pago NÃO foi somado outra vez. Duas varreduras dando dois meses por um
     * pagamento seria pior que a varredura não existir.
     */
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: antes.id } });
    expect(depois.currentPeriodEnd!.getTime()).toBe(antes.currentPeriodEnd!.getTime());
  });

  /**
   * O caso que apareceu em produção, do outro lado da cerca.
   *
   * Apagar uma conta (forçando, quando é teste) desliga as linhas de pagamento dela da
   * assinatura em vez de apagá-las — ver tests/apagar-conta.test.ts. É exatamente disto que a
   * varredura depende: a cobrança continua reconhecível pelo `externalId`, mesmo sem dono.
   *
   * Quando as linhas eram APAGADAS, o pagamento de uma conta excluída era redescoberto aqui
   * e abria caso em "Dinheiro sem destino" — o indicador que o painel chama de mais urgente,
   * porque cada real ali é alguém sem o que pagou — com alerta dizendo "quem pagou está sem
   * serviço". Ninguém esperava acesso e nada havia a devolver.
   */
  it("pagamento de conta APAGADA não é redescoberto como dinheiro sem destino", async () => {
    const id = `${PREFIXO}-pay-conta-apagada`;
    // O que sobra de uma exclusão forçada: receita registrada, sem assinatura.
    await prisma.payment.create({
      data: { subscriptionId: null, provider: "ASAAS", externalId: id, status: "APROVADO", amountCents: 4990 },
    });

    simularAsaas({ RECEIVED: [cobranca(id)] });
    const r = await reconciliarPagamentos();

    expect(r.jaConhecidas).toBe(1);
    expect(r.liberadas).toBe(0);
    expect(r.semLiberacao).toBe(0);
    // E nenhum caso aberto: sem linha nova pendente e sem alerta.
    expect(await prisma.payment.count({ where: { externalId: id, status: "PENDENTE" } })).toBe(0);
  });

  it("cobrança que virou CASO não é reprocessada — alerta repetido é alerta ignorado", async () => {
    /**
     * Dinheiro que entrou sem conta identificável é gravado como pendente e abre um caso
     * para uma pessoa decidir. O critério de "já vista" é QUALQUER registro de pagamento,
     * não só o aprovado — senão essa cobrança seria reprocessada em toda varredura e o
     * alerta dela sairia todo dia até alguém resolver.
     */
    simularAsaas({ RECEIVED: [cobranca(`${PREFIXO}-pay-sem-dono`, { externalReference: null })] });
    const primeira = await reconciliarPagamentos();
    expect(primeira.liberadas).toBe(0);
    expect(primeira.semLiberacao).toBe(1);

    simularAsaas({ RECEIVED: [cobranca(`${PREFIXO}-pay-sem-dono`, { externalReference: null })] });
    const segunda = await reconciliarPagamentos();

    expect(segunda.jaConhecidas).toBe(1);
    expect(segunda.semLiberacao).toBe(0);
  });
});

describe("honestidade sobre o que não deu para saber", () => {
  it("falha do provedor volta como FALHA, não como 'nada a liberar'", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errors: [{ description: "Acesso negado" }] }), { status: 401 }));

    const r = await reconciliarPagamentos();

    /**
     * Um zero mentiroso aqui esconderia exatamente o cliente que está sem acesso: quem lê
     * "0 liberados" e não vê falha conclui que está tudo entregue.
     */
    expect(r.falhou).toBe(true);
    expect(r.motivo).toContain("Acesso negado");
    expect(r.liberadas).toBe(0);
  });

  it("cobrança que não pode ser atribuída não impede a seguinte de liberar", async () => {
    /**
     * Cada cobrança da lista é de um cliente diferente, e a primeira aqui aponta para um
     * plano que não existe mais no catálogo — dinheiro que entrou e não vira acesso de
     * ninguém. A varredura tem de seguir: parar nela deixaria os clientes seguintes sem o
     * que pagaram.
     */
    simularAsaas({
      RECEIVED: [
        cobranca(`${PREFIXO}-pay-sem-plano`, { externalReference: `plano:plano-que-nao-existe:user:${userId}` }),
        cobranca(`${PREFIXO}-pay-boa`),
      ],
    });

    const r = await reconciliarPagamentos();

    expect(r.consultadas).toBe(2);
    expect(r.liberadas).toBe(1);
    expect(r.semLiberacao).toBe(1);
    const org = await prisma.organization.findFirstOrThrow({ where: { ownerId: userId } });
    expect(await prisma.subscription.count({ where: { organizationId: org.id, status: "ATIVA" } })).toBe(1);
  });

  /**
   * ⚠️ Este teste existe porque o de cima NÃO prova o que parecia provar.
   *
   * A primeira versão dele se chamava "uma cobrança que explode não interrompe as outras" e
   * passava — inclusive com o isolamento de erro REMOVIDO. Motivo: nenhum daqueles payloads
   * lança exceção. O código trata toda falha de atribuição com elegância (`dinheiroSemDestino`),
   * o que é ótimo e é exatamente por isso que o teste não media isolamento nenhum: media a
   * continuação do laço, que é outra garantia.
   *
   * Exceção de verdade aqui vem do BANCO — conexão derrubada, timeout no meio da varredura —,
   * e é ela que se simula: uma cobrança cuja leitura falha, entre duas boas.
   */
  it("erro de BANCO em uma cobrança não derruba a varredura", async () => {
    const { prisma: db } = await import("../src/lib/db");
    const idQuebrado = `${PREFIXO}-pay-banco-caiu`;

    simularAsaas({ RECEIVED: [cobranca(idQuebrado), cobranca(`${PREFIXO}-pay-depois`)] });

    const original = db.payment.findFirst.bind(db.payment);
    const espia = vi
      .spyOn(db.payment, "findFirst")
      .mockImplementation((async (args: { where?: { externalId?: string } }) => {
        if (args?.where?.externalId === idQuebrado) throw new Error("conexão com o banco perdida");
        return original(args as never);
      }) as never);

    try {
      const r = await reconciliarPagamentos();

      // A cobrança seguinte foi liberada mesmo assim: é o ponto todo.
      expect(r.liberadas).toBe(1);
      expect(r.semLiberacao).toBe(1);
      const org = await prisma.organization.findFirstOrThrow({ where: { ownerId: userId } });
      expect(await prisma.subscription.count({ where: { organizationId: org.id, status: "ATIVA" } })).toBe(1);
    } finally {
      espia.mockRestore();
    }
  });
});
