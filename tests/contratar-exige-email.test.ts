import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

/**
 * Contratar exige e-mail confirmado — decisão do dono.
 *
 * ── A falha que isto previne, e ela já aconteceu aqui ─────────────────────────
 * E-mail errado no cadastro só cobra o preço no momento em que alguém paga. Depois do
 * pagamento, TODO o contato passa por aquele endereço: aviso de acesso liberado, recuperação de
 * senha, segunda via do boleto, aviso de cobrança e de devolução. Endereço inalcançável
 * transforma a venda em "paguei e nunca entrei", e sem recuperação de senha a pessoa não se
 * resolve sozinha — este projeto já viveu isso, e a correção de e-mail no painel administrativo
 * existe por causa dele.
 *
 * ── O ESCOPO é parte da decisão, e por isso tem teste ─────────────────────────
 * O gate vale só na CONTRATAÇÃO. Crédito avulso exige assinatura com acesso, isto é, alguém que
 * JÁ entrou — e o gate existe justamente para evitar quem paga e não entra. Aplicá-lo ali seria
 * atrito num cliente que já é cliente, sem prevenir a falha. Este arquivo trava as duas metades:
 * o que é barrado e o que não é.
 *
 * A rota de checkout não tinha teste nenhum antes disto.
 */

process.env.ASAAS_API_KEY = "chave-de-teste-nao-vai-para-a-rede";
process.env.ASAAS_ENV = "sandbox";

const contexto = vi.hoisted(() => ({ userId: "", orgId: null as string | null, subId: null as string | null }));

vi.mock("@/lib/tenant", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/tenant")>();
  const { PrismaClient: PC } = await import("@prisma/client");
  const db = new PC();
  return {
    ...real,
    requireAppContext: async () => {
      const user = await db.user.findUniqueOrThrow({ where: { id: contexto.userId } });
      const org = contexto.orgId ? await db.organization.findUnique({ where: { id: contexto.orgId } }) : null;
      const sub = contexto.subId ? await db.subscription.findUnique({ where: { id: contexto.subId } }) : null;
      return {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        organization: org,
        subscription: sub,
        currentSubscription: sub,
        access: { hasAccess: Boolean(sub), reason: "ativa", message: "" },
        quota: { unlimited: false, quota: 20, used: 0, extra: 0, remaining: 20, allowed: true },
      };
    },
  };
});

const { GET: CHECKOUT } = await import("../src/app/api/assinatura/checkout/route");

const prisma = new PrismaClient();
const PREFIXO = "test-exige-email";

let planoId = "";

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
  await prisma.creditPack.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

beforeAll(async () => {
  await limpar();
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-mensal`,
      name: "Mensal (gate de e-mail)",
      priceCents: 4990,
      period: "MENSAL",
      monthlyAnalyses: 20,
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
  vi.unstubAllGlobals();
  await limpar();
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-mensal`,
      name: "Mensal (gate de e-mail)",
      priceCents: 4990,
      period: "MENSAL",
      monthlyAnalyses: 20,
      maxUsers: 1,
    },
  });
  planoId = plano.id;
  contexto.orgId = null;
  contexto.subId = null;
});

/** O Asaas simulado devolve o link; se o gate barrar, nada é chamado. */
function simularAsaas() {
  const chamadas: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL) => {
    chamadas.push(String(url));
    return new Response(JSON.stringify({ id: "chk_1", link: "https://asaas.test/checkout" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return chamadas;
}

async function conta(sufixo: string, opcoes: { confirmado: boolean }) {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Pessoa ${sufixo}`,
      passwordHash: "x",
      role: "CLIENTE",
      status: opcoes.confirmado ? "ATIVO" : "PENDENTE_VERIFICACAO",
      emailVerifiedAt: opcoes.confirmado ? new Date() : null,
    },
  });
  contexto.userId = user.id;
  return user;
}

/**
 * `NextRequest`, não `Request`: a rota lê `req.nextUrl`, que só o primeiro tem. Com o `Request`
 * comum o acesso estoura e a rota devolve 500 — o teste passaria a medir o meu arcabouço em vez
 * do gate, e um 500 esconderia tanto a recusa quanto a permissão.
 */
const pedido = (query: string) =>
  new NextRequest(`http://localhost/api/assinatura/checkout?${query}`) as never;

describe("contratar plano", () => {
  it("RECUSA com e-mail não confirmado, sem falar com o provedor", async () => {
    await conta("nao-confirmado", { confirmado: false });
    const chamadas = simularAsaas();

    const res = await CHECKOUT(pedido(`plano=${PREFIXO}-mensal`));
    const corpo = await res.json();

    expect(res.status).toBe(403);
    expect(corpo.reason).toBe("email_nao_confirmado");
    /**
     * A recusa tem de RESOLVER, não só anunciar: numa tela de pagamento, recusa sem próximo passo
     * é venda perdida. Diz onde reenviar e o caminho para quando o endereço está errado — o único
     * caso sem saída própria, porque trocar o e-mail hoje depende do atendimento.
     */
    expect(corpo.error).toContain("Reenviar");
    // E o caminho para endereço errado — agora auto-serviço, não mais o atendimento.
    expect(corpo.error).toContain("Trocar o e-mail");
    // Nada criado no provedor: cobrança que o cliente não vê é pior que venda recusada.
    expect(chamadas).toHaveLength(0);
  });

  it("PERMITE com e-mail confirmado", async () => {
    await conta("confirmado", { confirmado: true });
    const chamadas = simularAsaas();

    const res = await CHECKOUT(pedido(`plano=${PREFIXO}-mensal`));

    expect(res.status).toBe(200);
    expect(chamadas.length).toBeGreaterThan(0);
  });

  it("a data de confirmação é o que vale, não o status da conta", async () => {
    /**
     * ⚠️ `status` seria mais barato de ler e não serve: a rota administrativa permite pôr uma
     * conta em ATIVO sem tocar em `emailVerifiedAt`. Confiar no status deixaria passar quem nunca
     * confirmou, e o gate viraria decoração.
     */
    const user = await conta("ativo-sem-confirmar", { confirmado: false });
    await prisma.user.update({ where: { id: user.id }, data: { status: "ATIVO" } });
    const chamadas = simularAsaas();

    const res = await CHECKOUT(pedido(`plano=${PREFIXO}-mensal`));

    expect(res.status).toBe(403);
    expect(chamadas).toHaveLength(0);
  });
});

describe("o escopo do gate", () => {
  it("crédito avulso NÃO é barrado — quem tem acesso já entrou", async () => {
    /**
     * Trava do escopo, e é decisão registrada em teste: crédito avulso exige assinatura com
     * acesso, ou seja, alguém que já passou pela contratação. Barrar aqui seria atrito num
     * cliente que já é cliente, sem prevenir a falha que o gate existe para prevenir.
     */
    const user = await conta("pacote", { confirmado: false });
    const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org`, ownerId: user.id } });
    const sub = await prisma.subscription.create({
      data: {
        organizationId: org.id,
        planId: planoId,
        status: "ATIVA",
        provider: "ASAAS",
        amountCents: 4990,
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
        maxUsers: 1,
        analysesQuota: 20,
      },
    });
    contexto.orgId = org.id;
    contexto.subId = sub.id;
    await prisma.creditPack.create({
      data: { slug: `${PREFIXO}-pacote`, name: "10 créditos", credits: 10, priceCents: 5000, validityDays: 90 },
    });
    const chamadas = simularAsaas();

    const res = await CHECKOUT(pedido(`pacote=${PREFIXO}-pacote`));

    expect(res.status).toBe(200);
    expect(chamadas.length).toBeGreaterThan(0);
  });
});
