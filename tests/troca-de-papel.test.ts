import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

/**
 * Troca de papel revoga as sessões da pessoa.
 *
 * ── O defeito ─────────────────────────────────────────────────────────────────
 * Bloquear e suspender já revogavam; trocar o PAPEL não. Ficou concreto com o encerramento
 * por inatividade: o prazo depende do papel — equipe tem o curto, cliente o comum — e o
 * relógio da TELA recebe esse número no render do layout. Sem revogar, um cliente promovido
 * continuava com o relógio de 30 minutos na tela enquanto o servidor já aplicava 10, porque o
 * servidor relê o papel do banco em toda requisição.
 *
 * O resultado é o pior estado possível: sessão recusada no servidor com a tela ainda aberta e
 * os dados à mostra — exatamente o que o encerramento por inatividade existe para evitar.
 *
 * No sentido inverso é segurança comum: rebaixar alguém deixava a tela dele desenhada com o
 * menu e os atalhos do papel antigo até a próxima navegação.
 */

const contexto = vi.hoisted(() => ({ adminId: "" }));

/**
 * Só `requireRole` é substituído — a rota exige ADMIN autenticado e aqui não há cookie.
 * `revokeAllSessions` vem do módulo REAL pelo espalhamento: é justamente ela que está em teste.
 */
vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    requireRole: async () => ({
      id: contexto.adminId,
      email: "admin@teste.local",
      name: "Admin",
      role: "ADMIN",
      status: "ATIVO",
      organizationId: null,
      orgRole: null,
    }),
  };
});

const { PATCH } = await import("../src/app/api/admin/usuarios/[id]/route");

const prisma = new PrismaClient();
const PREFIXO = "test-papel";
const EVENTO = "sessoes_revogadas_por_troca_de_papel";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.securityEvent.deleteMany({ where: { email: { startsWith: PREFIXO } } });
}

beforeAll(limpar);

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await limpar();
  const admin = await prisma.user.create({
    data: { email: `${PREFIXO}-admin@exemplo.local`, name: "Admin", passwordHash: "x", role: "ADMIN", status: "ATIVO" },
  });
  contexto.adminId = admin.id;
});

/** Conta com uma sessão viva. */
async function contaComSessao(sufixo: string, papel: "CLIENTE" | "ADMIN" | "REVISOR" | "SUPORTE") {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Pessoa ${sufixo}`,
      passwordHash: "x",
      role: papel,
      status: "ATIVO",
    },
  });
  const sessao = await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hash(`${PREFIXO}-${sufixo}-token`),
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  return { user, sessao };
}

function pedido(corpo: Record<string, unknown>) {
  return new Request("http://localhost/api/admin/usuarios/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  }) as never;
}

describe("promover", () => {
  it("cliente promovido a ADMIN tem as sessões revogadas", async () => {
    const { user, sessao } = await contaComSessao("promovido", "CLIENTE");

    const res = await PATCH(pedido({ role: "ADMIN" }), { params: Promise.resolve({ id: user.id }) });
    expect(res.status).toBe(200);

    /**
     * A revogação é o que força entrada nova — e é assim que a tela passa a receber o prazo
     * de inatividade do papel novo (10 minutos, não 30).
     */
    const depois = await prisma.session.findUniqueOrThrow({ where: { id: sessao.id } });
    expect(depois.revokedAt).not.toBeNull();
  });

  it("deixa registro de segurança com o de→para, senão 'por que fui desconectado?' não tem resposta", async () => {
    const { user } = await contaComSessao("registro", "CLIENTE");

    await PATCH(pedido({ role: "REVISOR" }), { params: Promise.resolve({ id: user.id }) });

    const evento = await prisma.securityEvent.findFirstOrThrow({ where: { type: EVENTO, email: user.email } });
    const meta = evento.metadata as Record<string, unknown>;
    expect(meta.de).toBe("CLIENTE");
    expect(meta.para).toBe("REVISOR");
  });

  it("a auditoria diz o que mudou, não só que o campo foi tocado", async () => {
    const { user } = await contaComSessao("auditoria", "CLIENTE");

    await PATCH(pedido({ role: "SUPORTE" }), { params: Promise.resolve({ id: user.id }) });

    const registro = await prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.user.update", entityId: user.id },
    });
    const meta = registro.metadata as Record<string, unknown>;
    // "fields: [role]" não diz de onde para onde: sem isto a trilha não serve de prova.
    expect(meta.papelDe).toBe("CLIENTE");
    expect(meta.papelPara).toBe("SUPORTE");
    expect(meta.sessoesRevogadas).toBe(true);
  });
});

describe("rebaixar", () => {
  it("revisor rebaixado a CLIENTE também tem as sessões revogadas", async () => {
    /**
     * O sentido inverso é segurança comum: sem revogar, a tela dele continuava desenhada com o
     * menu e os atalhos do papel antigo até a próxima navegação.
     */
    const { user, sessao } = await contaComSessao("rebaixado", "REVISOR");

    await PATCH(pedido({ role: "CLIENTE" }), { params: Promise.resolve({ id: user.id }) });

    const depois = await prisma.session.findUniqueOrThrow({ where: { id: sessao.id } });
    expect(depois.revokedAt).not.toBeNull();
  });
});

describe("sem troca de papel", () => {
  it("⚠️ reenviar o MESMO papel NÃO derruba a sessão", async () => {
    /**
     * A guarda que evita transformar o conserto em estorvo. Salvar a tela sem mexer no papel
     * manda o valor atual de volta; sem a comparação com o anterior, isso desconectaria a
     * pessoa por nada — e regra que atrapalha sem motivo é regra que alguém desliga.
     */
    const { user, sessao } = await contaComSessao("igual", "REVISOR");

    const res = await PATCH(pedido({ role: "REVISOR" }), { params: Promise.resolve({ id: user.id }) });
    expect(res.status).toBe(200);

    const depois = await prisma.session.findUniqueOrThrow({ where: { id: sessao.id } });
    expect(depois.revokedAt).toBeNull();
    expect(await prisma.securityEvent.count({ where: { type: EVENTO, email: user.email } })).toBe(0);
  });

  it("mudar só o status para ATIVO não derruba a sessão", async () => {
    const { user, sessao } = await contaComSessao("status", "CLIENTE");

    await PATCH(pedido({ status: "ATIVO" }), { params: Promise.resolve({ id: user.id }) });

    const depois = await prisma.session.findUniqueOrThrow({ where: { id: sessao.id } });
    expect(depois.revokedAt).toBeNull();
  });

  it("bloquear continua revogando — o comportamento antigo não foi perdido", async () => {
    const { user, sessao } = await contaComSessao("bloqueado", "CLIENTE");

    await PATCH(pedido({ status: "BLOQUEADO" }), { params: Promise.resolve({ id: user.id }) });

    const depois = await prisma.session.findUniqueOrThrow({ where: { id: sessao.id } });
    expect(depois.revokedAt).not.toBeNull();
  });
});
