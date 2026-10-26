import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Quem dispara o processamento decide DE QUEM é o crédito.
 *
 * ── O defeito ─────────────────────────────────────────────────────────────────
 * A cobrança acontecia por conta própria: o motor debitava a assinatura da organização da
 * análise, sem olhar quem havia disparado. Um revisor ou o suporte abrindo a análise do
 * cliente e clicando em "Reprocessar" gastava crédito DELE, sem pedir nada a ninguém.
 *
 * Com a cobrança da diferença de faixa isso ficou mais caro: a equipe acrescenta um
 * documento para ajudar no atendimento, o processo sobe de faixa, e o cliente é debitado
 * por um trabalho que ele não pediu.
 *
 * ── Onde a decisão é provada ──────────────────────────────────────────────────
 * Na ROTA, que é onde o papel de quem pediu é conhecido — e com a fila substituída, para
 * o teste não depender do provedor de IA nem do armazenamento. O que se mede aqui é a
 * regra: cliente cobra, equipe não cobra, e cobrar em nome do cliente exige dizer.
 */

const contexto = vi.hoisted(() => ({ userId: "", orgId: "", subId: "", papel: "CLIENTE" as string }));
const fila = vi.hoisted(() => ({ chamadas: [] as { analysisId: string; opcoes?: { cobrarCliente?: boolean } }[] }));

/**
 * A fila é substituída de propósito: o que está em teste é a DECISÃO que a rota toma e
 * entrega ao trabalho, não o processamento. Rodar o motor aqui exigiria provedor de IA.
 */
vi.mock("@/lib/queue/queue", () => ({
  enqueueAnalysis: async (analysisId: string, opcoes?: { cobrarCliente?: boolean }) => {
    fila.chamadas.push({ analysisId, opcoes });
    return "queued" as const;
  },
}));

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
        user: { id: contexto.userId, email: "quem@teste.local", name: "Quem", role: contexto.papel },
        organization: org,
        subscription: sub,
        currentSubscription: sub,
        access: { hasAccess: true, reason: "ativa", message: "" },
        quota: { unlimited: false, quota: 20, used: 0, extra: 0, remaining: 20, allowed: true },
      };
    },
  };
});

const { POST: PROCESSAR } = await import("../src/app/api/analises/[id]/processar/route");

const prisma = new PrismaClient();
const PREFIXO = "test-reproc";

let planoId = "";
let analiseId = "";

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
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

beforeAll(async () => {
  await limpar();
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-mensal`,
      name: "Mensal (reproc)",
      priceCents: 4990,
      period: "MENSAL",
      monthlyAnalyses: 20,
      maxUsers: 1,
    },
  });
  planoId = plano.id;

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
  fila.chamadas = [];
  contexto.papel = "CLIENTE";
  await prisma.analysis.deleteMany({ where: { organizationId: contexto.orgId } });
  await prisma.subscription.deleteMany({ where: { organizationId: contexto.orgId } });
  const sub = await prisma.subscription.create({
    data: {
      organizationId: contexto.orgId,
      planId: planoId,
      status: "ATIVA",
      provider: "ASAAS",
      amountCents: 4990,
      currentPeriodEnd: new Date(Date.now() + 20 * 86400000),
      maxUsers: 1,
      analysesQuota: 20,
    },
  });
  contexto.subId = sub.id;

  const analise = await prisma.analysis.create({
    data: {
      organizationId: contexto.orgId,
      ownerId: contexto.userId,
      title: `${PREFIXO} análise`,
      type: "PRESCRICAO_INTERCORRENTE",
      status: "AGUARDANDO_REVISAO",
    },
  });
  analiseId = analise.id;
});

function pedido(corpo?: Record<string, unknown>) {
  return new Request("http://localhost/api/analises/x/processar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  }) as never;
}

describe("cliente disparando", () => {
  it("cobra, como sempre — é a análise dele, pedida por ele", async () => {
    const res = await PROCESSAR(pedido(), { params: Promise.resolve({ id: analiseId }) });

    expect(res.status).toBe(200);
    expect(fila.chamadas[0]?.opcoes?.cobrarCliente).toBe(true);
  });

  it("cliente não consegue pedir para NÃO ser cobrado", async () => {
    // O corpo é do cliente; aceitar `false` aqui seria análise de graça a pedido.
    const res = await PROCESSAR(pedido({ cobrarCliente: false }), { params: Promise.resolve({ id: analiseId }) });

    expect(res.status).toBe(200);
    expect(fila.chamadas[0]?.opcoes?.cobrarCliente).toBe(true);
  });
});

describe("equipe interna disparando", () => {
  it("NÃO cobra o cliente por padrão", async () => {
    contexto.papel = "ADMIN";

    const res = await PROCESSAR(pedido(), { params: Promise.resolve({ id: analiseId }) });
    const corpo = await res.json();

    // Revisão e suporte são trabalho nosso: o crédito do cliente não se mexe.
    expect(fila.chamadas[0]?.opcoes?.cobrarCliente).toBe(false);
    expect(corpo.data.message).toContain("NÃO foi debitado");
  });

  it("revisor também não cobra", async () => {
    contexto.papel = "REVISOR";

    await PROCESSAR(pedido(), { params: Promise.resolve({ id: analiseId }) });

    expect(fila.chamadas[0]?.opcoes?.cobrarCliente).toBe(false);
  });

  it("cobrar em nome do cliente é possível, mas exige dizer explicitamente", async () => {
    // O caso legítimo: o suporte reprocessa com documentos que o próprio cliente mandou.
    contexto.papel = "SUPORTE";

    await PROCESSAR(pedido({ cobrarCliente: true }), { params: Promise.resolve({ id: analiseId }) });

    expect(fila.chamadas[0]?.opcoes?.cobrarCliente).toBe(true);
  });

  it("fica na auditoria quem pediu e se o cliente foi cobrado", async () => {
    contexto.papel = "ADMIN";

    await PROCESSAR(pedido(), { params: Promise.resolve({ id: analiseId }) });

    /**
     * É o que permite auditar depois um débito que o cliente não reconhece — ou provar
     * que ele não aconteceu.
     */
    const registro = await prisma.auditLog.findFirst({
      where: { action: "analysis.process_requested", entityId: analiseId },
    });
    const meta = registro!.metadata as Record<string, unknown>;
    expect(meta.papel).toBe("ADMIN");
    expect(meta.cobrarCliente).toBe(false);
  });
});
