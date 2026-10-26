import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

/**
 * ⚠️ CLIQUE EM E-MAIL NÃO DESFAZ BLOQUEIO ADMINISTRATIVO.
 *
 * ── O achado, encontrado ao fechar os itens de usabilidade ─────────────────────
 * Este não estava na lista da revisão. Apareceu ao ler as rotas de link de e-mail para separar as
 * mensagens: DUAS delas gravavam `status: "ATIVO"` sem olhar o status atual, e as duas são
 * alcançáveis SEM sessão e SEM senha, só clicando num link que chega ao e-mail:
 *
 *  - `POST /api/auth/verificar-email` — a confirmação de cadastro;
 *  - `POST /api/auth/redefinir-senha` — o "esqueci minha senha".
 *
 * Consequência: conta BLOQUEADA ou SUSPENSA voltava a ATIVO. No primeiro caso bastava um link de
 * confirmação ainda vivo (2 dias de validade) de alguém bloqueado antes de confirmar. No segundo,
 * bastava pedir "esqueci minha senha" e definir uma senha nova — ou seja, QUALQUER conta bloqueada
 * se reativava sozinha, a qualquer momento, pelo caminho que o produto oferece na tela de entrada.
 *
 * Bloqueio é decisão de quem administra, e voltar dele é ato de quem o aplicou. É o mesmo defeito já
 * consertado na confirmação de TROCA de e-mail; ele estava nos três lugares, e este arquivo fecha os
 * dois que faltavam.
 *
 * ── E as mensagens não podem mentir ───────────────────────────────────────────
 * Com a trava, uma conta bloqueada tem o e-mail confirmado (ou a senha trocada) e SEGUE bloqueada.
 * Anunciar "sua conta está ativa" ali manda a pessoa bater numa porta fechada sem saber por quê — e
 * o suporte recebe a reclamação errada.
 */

process.env.EMAIL_DRIVER = "console";

const { POST: VERIFICAR } = await import("../src/app/api/auth/verificar-email/route");
const { POST: REDEFINIR } = await import("../src/app/api/auth/redefinir-senha/route");
const { hashPassword } = await import("../src/lib/password");

const prisma = new PrismaClient();
const PREFIXO = "test-reativa";
const SENHA_NOVA = "SenhaForte#2026";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.consent.deleteMany({ where: { userId: { in: ids } } });
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

type Status = "PENDENTE_VERIFICACAO" | "ATIVO" | "BLOQUEADO" | "SUSPENSO";

/**
 * ⚠️ `emailVerifiedAt` começa NULO em toda conta deste arquivo, inclusive nas bloqueadas.
 *
 * A primeira versão gravava a data para tudo que não fosse PENDENTE_VERIFICACAO — e isso esvaziava a
 * asserção `expect(depois.emailVerifiedAt).not.toBeNull()` do teste de conta bloqueada: ela já era
 * verdadeira ANTES de a rota rodar. O teste dizia "a confirmação acontece, o bloqueio permanece" e só
 * media a segunda metade. Com a data nula, ele passa a provar as duas.
 */
async function conta(sufixo: string, status: Status) {
  return prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Pessoa ${sufixo}`,
      passwordHash: await hashPassword("SenhaAntiga#2026"),
      role: "CLIENTE",
      status,
      emailVerifiedAt: null,
    },
  });
}

async function link(userId: string, tipo: "VERIFICACAO_EMAIL" | "RECUPERACAO_SENHA", emClaro: string) {
  return prisma.authToken.create({
    data: { userId, type: tipo, tokenHash: hash(emClaro), expiresAt: new Date(Date.now() + 3_600_000) },
  });
}

const pedido = (url: string, corpo: Record<string, unknown>, ip: string) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-real-ip": ip },
    body: JSON.stringify(corpo),
  }) as never;

const pedidoDeVerificacao = (token: string) =>
  pedido("http://localhost/api/auth/verificar-email", { token }, "10.5.0.1");

const pedidoDeRedefinicao = (token: string, ip: string) =>
  pedido("http://localhost/api/auth/redefinir-senha", { token, password: SENHA_NOVA }, ip);

describe("confirmação de cadastro", () => {
  for (const bloqueio of ["BLOQUEADO", "SUSPENSO"] as const) {
    it(`⚠️ NÃO reativa conta ${bloqueio} — a rota é pública`, async () => {
      const user = await conta(`verif-${bloqueio.toLowerCase()}`, bloqueio);
      await link(user.id, "VERIFICACAO_EMAIL", `token-verificacao-${bloqueio}`);

      const res = await VERIFICAR(pedidoDeVerificacao(`token-verificacao-${bloqueio}`));

      // A confirmação acontece — o endereço é dele —, mas o bloqueio permanece.
      expect(res.status).toBe(200);
      expect(user.emailVerifiedAt).toBeNull(); // ponto de partida, senão a asserção seguinte é vazia
      const depois = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(depois.status).toBe(bloqueio);
      expect(depois.emailVerifiedAt).not.toBeNull();
      // E a mensagem não promete acesso que não existe.
      expect((await res.json()).data.message).not.toContain("ativa");
    });
  }

  it("conta PENDENTE_VERIFICACAO passa a ATIVO — é o que a confirmação resolve", async () => {
    /**
     * O outro lado da trava. Sem esta asserção, "não mexer no status" poderia ser implementado como
     * "nunca mexer no status" — e aí ninguém mais ativaria a conta ao confirmar o cadastro, que é a
     * função inteira da rota.
     */
    const user = await conta("verif-pendente", "PENDENTE_VERIFICACAO");
    await link(user.id, "VERIFICACAO_EMAIL", "token-verificacao-pendente");

    const res = await VERIFICAR(pedidoDeVerificacao("token-verificacao-pendente"));

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("ATIVO");
    expect((await res.json()).data.message).toContain("ativa");
  });
});

describe("redefinição de senha", () => {
  for (const bloqueio of ["BLOQUEADO", "SUSPENSO"] as const) {
    it(`⚠️ NÃO reativa conta ${bloqueio} — bastava "esqueci minha senha"`, async () => {
      /**
       * O pior dos dois: não dependia de link antigo nenhum. Qualquer conta bloqueada pedia
       * recuperação de senha na tela de entrada, definia senha nova e voltava a ATIVO.
       */
      const user = await conta(`senha-${bloqueio.toLowerCase()}`, bloqueio);
      await link(user.id, "RECUPERACAO_SENHA", `token-recuperacao-${bloqueio}`);

      const res = await REDEFINIR(pedidoDeRedefinicao(`token-recuperacao-${bloqueio}`, `10.5.1.${bloqueio.length}`));

      expect(res.status).toBe(200);
      const depois = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(depois.status).toBe(bloqueio);
      // A senha É trocada: a pessoa tem direito à própria senha. O que ela não ganha é o acesso.
      expect(depois.passwordHash).not.toBe(user.passwordHash);
      // E a mensagem diz a verdade em vez de "você já pode entrar".
      expect((await res.json()).data.message).toContain("suporte");
    });
  }

  it("conta PENDENTE_VERIFICACAO passa a ATIVO ao definir a senha", async () => {
    const user = await conta("senha-pendente", "PENDENTE_VERIFICACAO");
    await link(user.id, "RECUPERACAO_SENHA", "token-recuperacao-pendente");

    const res = await REDEFINIR(pedidoDeRedefinicao("token-recuperacao-pendente", "10.5.2.1"));

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("ATIVO");
    expect((await res.json()).data.message).toContain("já pode entrar");
  });

  it("conta ATIVO continua ATIVO", async () => {
    // A trava não pode rebaixar quem já estava dentro.
    const user = await conta("senha-ativo", "ATIVO");
    await link(user.id, "RECUPERACAO_SENHA", "token-recuperacao-ativo");

    await REDEFINIR(pedidoDeRedefinicao("token-recuperacao-ativo", "10.5.2.2"));

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("ATIVO");
  });
});
