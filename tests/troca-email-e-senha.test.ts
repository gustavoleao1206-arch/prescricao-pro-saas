import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

/**
 * Trocar a senha desarma a troca de e-mail pendente.
 *
 * ── O CAMINHO DE TOMADA DE CONTA que este arquivo fecha ───────────────────────
 * Confirmado por revisão de segurança, em código que entrou em produção no mesmo dia:
 *
 *   1. Atacante que sabe a senha (reusada, vazada de outro site, vista sendo digitada) pede a
 *      troca do e-mail para um endereço dele. Aceito — a rota só exige sessão e senha.
 *   2. A vítima recebe o aviso no endereço ANTIGO, que diz literalmente "troque sua senha agora".
 *   3. A vítima OBEDECE, em minutos.
 *   4. O link do atacante continua válido pela hora inteira, e a confirmação é rota PÚBLICA — sem
 *      sessão e sem senha. Ele clica, e o e-mail da conta passa a ser dele.
 *   5. Ele pede "esqueci minha senha" no endereço novo e define a senha. Conta e assinatura paga
 *      tomadas.
 *
 * A vítima fazia exatamente o que o produto instruiu, no prazo, e perdia a conta. Alarme que
 * orienta para ação inútil é pior que alarme nenhum: ensina a confiar no lugar errado.
 *
 * ── Por que arquivo separado ──────────────────────────────────────────────────
 * A regra vive em DUAS rotas — `/api/conta/senha` (senha atual) e `redefinir-senha` ("esqueci
 * minha senha", que é o caminho que a vítima assustada usa). Testar as duas juntas é o que
 * garante que a proteção não existe só na metade que alguém lembrou.
 */

process.env.EMAIL_DRIVER = "console";

const contexto = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  const { PrismaClient: PC } = await import("@prisma/client");
  const db = new PC();
  return {
    ...real,
    requireUser: async () => {
      const u = await db.user.findUniqueOrThrow({ where: { id: contexto.userId } });
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        status: u.status,
        organizationId: u.organizationId,
        orgRole: u.orgRole,
        emailVerifiedAt: u.emailVerifiedAt,
      };
    },
  };
});

const { POST: TROCAR_SENHA } = await import("../src/app/api/conta/senha/route");
const { POST: REDEFINIR_SENHA } = await import("../src/app/api/auth/redefinir-senha/route");
const { pedirTrocaDeEmail, confirmarTrocaDeEmail } = await import("../src/lib/troca-de-email");
const { hashPassword } = await import("../src/lib/password");

const prisma = new PrismaClient();
const PREFIXO = "test-senha-troca";
const SENHA = "SenhaForte#2026";
const SENHA_NOVA = "OutraSenhaForte#2026";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

async function limpar() {
  const users = await prisma.user.findMany({
    where: { OR: [{ email: { startsWith: PREFIXO } }, { pendingEmail: { startsWith: PREFIXO } }] },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.securityEvent.deleteMany({ where: { email: { startsWith: PREFIXO } } });
}

beforeEach(limpar);

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

/** Conta com uma troca de e-mail pendente e o link do "atacante" conhecido pelo teste. */
async function contaComTrocaPendente(sufixo: string, token: string) {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Vítima ${sufixo}`,
      passwordHash: await hashPassword(SENHA),
      role: "CLIENTE",
      status: "ATIVO",
      emailVerifiedAt: new Date(),
    },
  });
  contexto.userId = user.id;

  await pedirTrocaDeEmail(user.id, `${PREFIXO}-${sufixo}-atacante@exemplo.local`, SENHA);
  const registro = await prisma.authToken.findFirstOrThrow({
    where: { userId: user.id, type: "TROCA_EMAIL", usedAt: null },
  });
  await prisma.authToken.update({ where: { id: registro.id }, data: { tokenHash: hash(token) } });
  return user;
}

describe("Configurações → Alterar senha", () => {
  it("⚠️ cancela a troca pendente — o link do atacante morre", async () => {
    const user = await contaComTrocaPendente("atual", "token-atual");

    const res = await TROCAR_SENHA(
      new Request("http://localhost/api/conta/senha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: SENHA, newPassword: SENHA_NOVA }),
      }) as never,
    );
    expect(res.status).toBe(200);

    // A asserção que fecha a tomada de conta: o link não aplica mais nada.
    const tentativa = await confirmarTrocaDeEmail("token-atual");
    expect(tentativa.ok).toBe(false);

    const depois = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(depois.email).toBe(user.email);
    expect(depois.pendingEmail).toBeNull();
  });

  it("a resposta DIZ que a troca pendente foi cancelada", async () => {
    /**
     * Sem essa frase, quem trocou a senha por susto não sabe se o pedido morreu — e continuaria
     * sem saber o que mais precisa fazer. A mensagem é a única confirmação que a pessoa recebe.
     */
    await contaComTrocaPendente("mensagem", "token-mensagem");

    const res = await TROCAR_SENHA(
      new Request("http://localhost/api/conta/senha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: SENHA, newPassword: SENHA_NOVA }),
      }) as never,
    );

    expect((await res.json()).data.message).toContain("cancelado");
  });

  it("senha atual errada não cancela nada — recusa não pode ter efeito colateral", async () => {
    const user = await contaComTrocaPendente("errada", "token-errada");

    const res = await TROCAR_SENHA(
      new Request("http://localhost/api/conta/senha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: "errada", newPassword: SENHA_NOVA }),
      }) as never,
    );

    expect(res.status).toBe(400);
    // O pedido continua de pé: quem errou a senha não mexeu no estado da conta.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingEmail).not.toBeNull();
  });
});

describe("Esqueci minha senha", () => {
  it("⚠️ também cancela a troca pendente — é o caminho que a vítima assustada usa", async () => {
    /**
     * O aviso manda "trocar a senha", e quem está assustado clica em "esqueci minha senha". Este
     * caminho revogava sessões e NÃO desarmava o pedido — e revogar sessão não ajudava, porque a
     * confirmação é pública: o link sobrevivia à revogação.
     */
    const user = await contaComTrocaPendente("reset", "token-reset");
    await prisma.authToken.create({
      data: {
        userId: user.id,
        type: "RECUPERACAO_SENHA",
        tokenHash: hash("token-de-reset"),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const res = await REDEFINIR_SENHA(
      new Request("http://localhost/api/auth/redefinir-senha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "token-de-reset", password: SENHA_NOVA }),
      }) as never,
    );
    expect(res.status).toBe(200);

    const tentativa = await confirmarTrocaDeEmail("token-reset");
    expect(tentativa.ok).toBe(false);

    const depois = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(depois.email).toBe(user.email);
    expect(depois.pendingEmail).toBeNull();
  });
});
