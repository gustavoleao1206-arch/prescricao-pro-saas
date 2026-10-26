import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * A troca de e-mail não pode ser um oráculo de senha.
 *
 * ── O achado ──────────────────────────────────────────────────────────────────
 * A rota confere a SENHA ATUAL — de propósito, porque sessão roubada não deve poder apontar a
 * conta para outro endereço. Só que a conferência não olhava `lockedUntil` e o erro não contava
 * para `failedLoginCount`. Resultado: quem tivesse uma sessão roubada podia testar senhas por aqui
 * sem nunca travar a conta, contornando por completo a trava que o login aplica depois de poucas
 * tentativas.
 *
 * O único teto era um balde EM MEMÓRIA (5 em 15 minutos), que zera a cada deploy e não sobrevive a
 * reinício — proteção que o atacante recupera esperando.
 *
 * ── Uma trava, um lugar ───────────────────────────────────────────────────────
 * Erro aqui e erro no login somam no MESMO contador, com o mesmo limite e o mesmo prazo. Se
 * fossem contadores separados, bastaria alternar entre as duas rotas para nunca travar.
 */

const { pedirTrocaDeEmail } = await import("../src/lib/troca-de-email");
const { hashPassword } = await import("../src/lib/password");
const { env } = await import("../src/lib/env");

const prisma = new PrismaClient();
const PREFIXO = "test-oraculo";
const SENHA = "SenhaForte#2026";

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
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

async function conta(sufixo: string) {
  return prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Pessoa ${sufixo}`,
      passwordHash: await hashPassword(SENHA),
      role: "CLIENTE",
      status: "ATIVO",
      emailVerifiedAt: new Date(),
    },
  });
}

const destino = (s: string) => `${PREFIXO}-${s}-novo@exemplo.local`;

describe("erro de senha conta para a trava", () => {
  it("cada tentativa errada incrementa o MESMO contador do login", async () => {
    const user = await conta("conta-erro");

    await pedirTrocaDeEmail(user.id, destino("conta-erro"), "errada");

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginCount).toBe(1);
  });

  it("⚠️ ao atingir o limite, a conta TRAVA — como no login", async () => {
    const user = await conta("trava");
    const limite = env.security.loginMaxAttempts;

    for (let i = 0; i < limite; i++) {
      await pedirTrocaDeEmail(user.id, destino("trava"), "errada");
    }

    const depois = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(depois.lockedUntil).not.toBeNull();
    expect(depois.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("acertar a senha zera o contador, senão a trava chegaria por erros antigos", async () => {
    const user = await conta("zera");
    await pedirTrocaDeEmail(user.id, destino("zera"), "errada");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginCount).toBe(1);

    await pedirTrocaDeEmail(user.id, destino("zera"), SENHA);

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginCount).toBe(0);
  });
});

describe("conta travada", () => {
  it("⚠️ RECUSA a troca — a trava do login vale aqui", async () => {
    /**
     * A asserção que fecha o oráculo. Sem ela, a conta travada no login continuava aceitando
     * tentativas de senha por esta rota: o atacante trocava de porta e seguia adivinhando.
     */
    const user = await conta("travada");
    await prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil: new Date(Date.now() + 10 * 60_000) },
    });

    const r = await pedirTrocaDeEmail(user.id, destino("travada"), SENHA);

    expect(r.aceito).toBe(false);
    expect(r.recusa).toBe("conta_travada");
    // E nem com a senha CERTA: travada é travada, senão a recusa seria só para quem erra.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingEmail).toBeNull();
  });

  it("trava vencida volta a aceitar", async () => {
    // Trava é temporária; se não expirasse, um ataque trancaria o dono para sempre.
    const user = await conta("vencida");
    await prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil: new Date(Date.now() - 60_000) },
    });

    expect((await pedirTrocaDeEmail(user.id, destino("vencida"), SENHA)).aceito).toBe(true);
  });
});
