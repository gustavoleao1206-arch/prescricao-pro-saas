import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Reenvio do e-mail de confirmação de cadastro.
 *
 * ── O que faltava ─────────────────────────────────────────────────────────────
 * Não havia como pedir outro e-mail. Se o primeiro se perdia — caixa de spam, endereço com um
 * dígito errado depois corrigido pelo painel, entrega recusada pelo servidor de destino —, a
 * pessoa ficava com a conta pendente e nenhum caminho dentro do produto. O único jeito era usar
 * "esqueci minha senha", que verifica o e-mail como efeito colateral: funciona por acidente.
 *
 * ── Por que é rota AUTENTICADA ────────────────────────────────────────────────
 * Conta pendente NÃO é impedida de entrar, então quem precisa do reenvio pede de dentro. Isso
 * elimina os dois problemas de uma rota pública que recebe e-mail: descobrir quem tem conta, e
 * mandar e-mail nosso repetidamente para o endereço de qualquer pessoa — o que derruba a
 * reputação de remetente que faz o e-mail de cobrança chegar na caixa de entrada.
 */

process.env.EMAIL_DRIVER = "console";

const contexto = vi.hoisted(() => ({ userId: "" }));

/** Só `requireUser` é substituído: aqui não há cookie, e a regra em teste é a da rota. */
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
      };
    },
  };
});

const { POST: REENVIAR } = await import("../src/app/api/auth/reenviar-verificacao/route");

const prisma = new PrismaClient();
const PREFIXO = "test-reenvio";

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

beforeEach(limpar);

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

/**
 * Conta nova a cada teste, com e-mail único.
 *
 * O e-mail carrega o sufixo porque o limite de envios é por CONTA: contas diferentes têm cotas
 * independentes, e sem isso um teste gastaria a cota do seguinte — o pior tipo de dependência de
 * ordem, porque o teste falharia por causa de outro.
 */
async function conta(sufixo: string, opcoes: { verificado?: boolean } = {}) {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Pessoa ${sufixo}`,
      passwordHash: "x",
      role: "CLIENTE",
      status: opcoes.verificado ? "ATIVO" : "PENDENTE_VERIFICACAO",
      emailVerifiedAt: opcoes.verificado ? new Date() : null,
    },
  });
  contexto.userId = user.id;
  return user;
}

const pedido = () => new Request("http://localhost/api/auth/reenviar-verificacao", { method: "POST" }) as never;

async function linksVivos(userId: string) {
  return prisma.authToken.count({ where: { userId, type: "VERIFICACAO_EMAIL", usedAt: null } });
}

describe("conta pendente de confirmação", () => {
  it("cria um link novo e diz que enviou", async () => {
    const user = await conta("novo");

    const res = await REENVIAR(pedido());
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.enviado).toBe(true);
    // A mensagem diz PARA ONDE foi: sem isso a pessoa não descobre o endereço com dígito errado.
    expect(corpo.data.message).toContain(user.email);
    expect(await linksVivos(user.id)).toBe(1);
  });

  it("⚠️ INVALIDA os links anteriores — só o último vale", async () => {
    /**
     * O caso que importa é o do endereço digitado errado e depois corrigido pelo painel: o link
     * antigo foi para a caixa de um terceiro, e sem invalidar ele continuaria podendo ativar a
     * conta de outra pessoa por dois dias. E é também o que "reenviar" significa para quem clica.
     */
    const user = await conta("invalida");
    await prisma.authToken.create({
      data: {
        userId: user.id,
        type: "VERIFICACAO_EMAIL",
        tokenHash: `${PREFIXO}-hash-antigo`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    expect(await linksVivos(user.id)).toBe(1);

    await REENVIAR(pedido());

    // Um só: o antigo foi marcado como usado, o novo entrou.
    expect(await linksVivos(user.id)).toBe(1);
    const antigo = await prisma.authToken.findFirstOrThrow({ where: { tokenHash: `${PREFIXO}-hash-antigo` } });
    expect(antigo.usedAt).not.toBeNull();
  });

  it("o link novo vale 2 dias, o mesmo prazo do cadastro", async () => {
    const user = await conta("prazo");

    await REENVIAR(pedido());

    const link = await prisma.authToken.findFirstOrThrow({
      where: { userId: user.id, type: "VERIFICACAO_EMAIL", usedAt: null },
    });
    const dias = (link.expiresAt.getTime() - Date.now()) / 86_400_000;
    // Prazo vindo de um lugar só (`VALIDADE_DO_LINK_MS`): duas cópias divergiriam.
    expect(dias).toBeGreaterThan(1.9);
    expect(dias).toBeLessThan(2.1);
  });

  it("deixa registro em auditoria", async () => {
    const user = await conta("auditoria");

    await REENVIAR(pedido());

    const registro = await prisma.auditLog.findFirstOrThrow({
      where: { action: "auth.verification_resent", entityId: user.id },
    });
    expect((registro.metadata as Record<string, unknown>).enviado).toBe(true);
  });
});

describe("conta já confirmada", () => {
  it("NÃO envia, e diz que já está confirmada", async () => {
    /**
     * Reenviar aqui seria pior que inútil: a pessoa receberia um link de confirmação para uma
     * conta já confirmada e concluiria que a verificação anterior não valeu.
     */
    const user = await conta("confirmada", { verificado: true });

    const res = await REENVIAR(pedido());
    const corpo = await res.json();

    expect(corpo.data.enviado).toBe(false);
    expect(corpo.data.jaVerificado).toBe(true);
    expect(await linksVivos(user.id)).toBe(0);
  });
});

describe("limite de envios", () => {
  it("recusa a partir do quarto pedido seguido, com 429", async () => {
    /**
     * O abuso que importa não é de rede: é a mesma pessoa clicando dez vezes por não ver o
     * e-mail chegar. Cada clique é um envio, e envio repetido para o mesmo endereço derruba a
     * reputação do remetente e joga tudo na caixa de spam — inclusive o e-mail seguinte, que
     * pode ser o de cobrança.
     */
    await conta("limite");

    for (let i = 0; i < 3; i++) {
      expect((await REENVIAR(pedido())).status).toBe(200);
    }

    const quarta = await REENVIAR(pedido());
    expect(quarta.status).toBe(429);
    const recusa = (await quarta.json()).error;
    // A recusa orienta em vez de só negar: a caixa de spam é a causa mais comum.
    expect(recusa).toContain("spam");
    /**
     * ⚠️ E DIZ O PRAZO, com o número.
     *
     * A recusa dizia "aguarde alguns minutos" para uma janela de 15 — e a pessoa voltava em dois, era
     * recusada, voltava em cinco, era recusada, e desistia. O prazo sempre esteve disponível
     * (`rateLimit` devolve `resetAt`) e nenhuma rota o lia. Sem esta asserção, o conserto podia ser
     * desfeito em todas as oito rotas com a suíte verde: os testes do texto vivem em
     * `tests/espera-do-limite.test.ts` e provam a FUNÇÃO, não que alguém a chame.
     */
    expect(recusa).toMatch(/\d+ minutos|1 minuto/);
  });

  it("o limite é por CONTA — outra conta tem cota própria", async () => {
    /**
     * Por IP, quem estivesse atrás do mesmo escritório dividiria a cota e um bloquearia o outro.
     */
    await conta("cota-a");
    for (let i = 0; i < 3; i++) await REENVIAR(pedido());
    expect((await REENVIAR(pedido())).status).toBe(429);

    await conta("cota-b");
    expect((await REENVIAR(pedido())).status).toBe(200);
  });
});
