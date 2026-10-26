import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { MAX_TENTATIVAS_WEBHOOK, tratarFalhaDeWebhook } from "../src/lib/webhook-falha";

/**
 * Falha ao processar um evento do provedor — e a fila que ela travava.
 *
 * ── O defeito ─────────────────────────────────────────────────────────────────
 * A rota do webhook devolvia 500 em qualquer erro inesperado, para o Asaas reenviar. A
 * intenção estava certa — pagamento não pode ser perdido por falha momentânea —, mas o
 * Asaas não trata a fila como entregas independentes: ela é INTERROMPIDA no evento que
 * falha, e nenhum evento posterior é entregue enquanto aquele não passar.
 *
 * Um único evento que falha SEMPRE — chave única duplicada num estorno reenviado, plano
 * apagado do catálogo, dado inconsistente — parava a entrada de TODOS os pagamentos
 * seguintes. Ninguém recebia acesso, ninguém renovava, e o sintoma do nosso lado era
 * "parou de chegar pagamento", sem nada apontando para a causa. O defeito não custa um
 * cliente: custa todos, a partir daquele minuto.
 *
 * ── O que estes testes travam ─────────────────────────────────────────────────
 * A decisão entre REENVIAR (falha transitória: vale tentar) e DISPENSAR (falha que se
 * repetiria para sempre: a fila vale mais que o evento). Dispensar sem registro seria
 * trocar um problema visível por um invisível, então dispensa sempre vem com alerta.
 */

const prisma = new PrismaClient();
const PREFIXO = "test-wh-falha";
const TIPO_FALHA = "webhook_falha_no_processamento";

function evento(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    event: "PAYMENT_REFUNDED",
    payment: { id: `${id}-pay`, value: 49.9 },
    ...extra,
  };
}

/** Erro do Prisma, como ele chega de verdade: um `Error` com `code`. */
function erroPrisma(code: string): Error {
  const e = new Error(`Unique constraint failed (${code})`);
  (e as Error & { code: string }).code = code;
  return e;
}

async function limpar() {
  await prisma.securityEvent.deleteMany({
    where: { metadata: { path: ["chave"], string_starts_with: PREFIXO } },
  });
}

beforeAll(limpar);
beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

describe("falha transitória", () => {
  it("pede reenvio: pagamento não se perde por banco fora do ar", async () => {
    const d = await tratarFalhaDeWebhook("asaas", evento(`${PREFIXO}-t1`), new Error("connect ECONNREFUSED"));

    expect(d.reenviar).toBe(true);
    expect(d.tentativas).toBe(1);
  });

  it("conta as tentativas do MESMO evento", async () => {
    const ev = evento(`${PREFIXO}-t2`);
    await tratarFalhaDeWebhook("asaas", ev, new Error("timeout"));
    const segunda = await tratarFalhaDeWebhook("asaas", ev, new Error("timeout"));

    expect(segunda.tentativas).toBe(2);
    expect(segunda.reenviar).toBe(true);
  });

  it("passado o teto, LIBERA a fila mesmo sem entender o erro", async () => {
    /**
     * O erro que parece transitório e não é. Sem teto, ele reenviaria para sempre — e a
     * fila do provedor ficaria parada para sempre com ele.
     */
    const ev = evento(`${PREFIXO}-t3`);
    let ultima = await tratarFalhaDeWebhook("asaas", ev, new Error("erro estranho"));
    for (let i = 1; i < MAX_TENTATIVAS_WEBHOOK; i++) {
      ultima = await tratarFalhaDeWebhook("asaas", ev, new Error("erro estranho"));
    }

    expect(ultima.tentativas).toBe(MAX_TENTATIVAS_WEBHOOK);
    expect(ultima.reenviar).toBe(false);
    expect(ultima.motivo).toContain("liberada");
  });
});

describe("falha determinística", () => {
  /**
   * O caso concreto que originou tudo: o segundo evento de estorno do mesmo pagamento
   * colidindo na chave única do lançamento de bloqueio. Reenviar dá o mesmo erro, sempre.
   */
  it("chave única duplicada NÃO pede reenvio — nem na primeira vez", async () => {
    const d = await tratarFalhaDeWebhook("asaas", evento(`${PREFIXO}-d1`), erroPrisma("P2002"));

    expect(d.reenviar).toBe(false);
    expect(d.tentativas).toBe(1);
    expect(d.motivo).toContain("determinística");
  });

  it("registro inexistente e chave estrangeira também são definitivos", async () => {
    expect((await tratarFalhaDeWebhook("asaas", evento(`${PREFIXO}-d2`), erroPrisma("P2025"))).reenviar).toBe(false);
    expect((await tratarFalhaDeWebhook("asaas", evento(`${PREFIXO}-d3`), erroPrisma("P2003"))).reenviar).toBe(false);
  });

  it("erro de programação é definitivo: o mesmo corpo produz o mesmo defeito", async () => {
    const d = await tratarFalhaDeWebhook(
      "asaas",
      evento(`${PREFIXO}-d4`),
      new TypeError("Cannot read properties of null"),
    );
    expect(d.reenviar).toBe(false);
  });

  it("erro de conexão do provedor continua sendo transitório", async () => {
    // `Error` genérico é o que a integração levanta em falha de rede — não pode cair
    // na mesma vala do erro de programação.
    const d = await tratarFalhaDeWebhook("asaas", evento(`${PREFIXO}-d5`), new Error("Asaas respondeu 503."));
    expect(d.reenviar).toBe(true);
  });
});

describe("registro e alerta", () => {
  it("toda falha fica registrada, com o erro e a contagem", async () => {
    await tratarFalhaDeWebhook("asaas", evento(`${PREFIXO}-r1`), new Error("timeout na leitura"));

    const registro = await prisma.securityEvent.findFirst({
      where: { type: TIPO_FALHA, metadata: { path: ["chave"], equals: `${PREFIXO}-r1` } },
    });
    expect(registro).not.toBeNull();
    const meta = registro!.metadata as Record<string, unknown>;
    expect(meta.erro).toContain("timeout");
    expect(meta.tentativas).toBe(1);
    expect(meta.evento).toBe("PAYMENT_REFUNDED");
  });

  it("evento DISPENSADO gera alerta à operação; reenviado não gera", async () => {
    await tratarFalhaDeWebhook("asaas", evento(`${PREFIXO}-r2`), erroPrisma("P2002"));
    await tratarFalhaDeWebhook("asaas", evento(`${PREFIXO}-r3`), new Error("timeout"));

    /**
     * Dispensado nunca mais volta — precisa de gente. Enquanto há reenvio previsto, o
     * caso pode se resolver sozinho, e avisar seria ruído no canal que tem de ser lido.
     */
    const dispensado = await prisma.securityEvent.count({
      where: { type: "webhook_evento_dispensado", metadata: { path: ["chave"], equals: `${PREFIXO}-r2` } },
    });
    expect(dispensado).toBe(1);
    const reenviado = await prisma.securityEvent.count({
      where: { type: "webhook_evento_dispensado", metadata: { path: ["chave"], equals: `${PREFIXO}-r3` } },
    });
    expect(reenviado).toBe(0);
  });

  it("sem id de evento, conta pelo id do pagamento", async () => {
    const semId = { event: "PAYMENT_REFUNDED", payment: { id: `${PREFIXO}-so-pagamento` } };
    await tratarFalhaDeWebhook("asaas", semId, new Error("timeout"));
    const segunda = await tratarFalhaDeWebhook("asaas", semId, new Error("timeout"));

    expect(segunda.tentativas).toBe(2);
  });

  it("nunca lança: falha ao registrar não pode esconder a causa original", async () => {
    // Corpo sem nada reconhecível — o pior caso para quem só sabe ler `payload.id`.
    const d = await tratarFalhaDeWebhook("asaas", {}, new Error("erro qualquer"));
    expect(d.reenviar).toBe(true);
  });
});
