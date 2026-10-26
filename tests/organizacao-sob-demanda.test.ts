import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * A organização criada sob demanda — uma regra, um lugar.
 *
 * ── O que estava errado ───────────────────────────────────────────────────────
 * A organização é o que isola um escritório do outro: toda leitura de dado do cliente
 * deriva dela. E ela nascia em TRÊS lugares, com o mesmo código copiado — cadastro pelo
 * site, webhook do Asaas na primeira aprovação, e liberação manual pelo painel. Três
 * cópias da mesma regra é como as três divergem.
 *
 * Havia um quarto lugar que precisava dela e simplesmente RECUSAVA: as rotas de criar
 * análise devolviam "Organização não encontrada" para toda conta que não tivesse passado
 * por um daqueles três caminhos — o ADMIN da semente, um REVISOR, um SUPORTE. A conta
 * existia, estava autenticada, e não conseguia criar análise nenhuma. A mensagem não dizia
 * o que fazer porque não havia nada a fazer.
 *
 * Apareceu no primeiro teste de boleto pela tela: a conta de administrador não tinha
 * organização, e a mesma mensagem barrava a emissão do boleto (ali o guarda era morto — a
 * rota nem usava o dado) e barraria a criação da análise em seguida.
 */

process.env.ASAAS_API_KEY = "chave-de-teste-nao-vai-para-a-rede";

const contexto = vi.hoisted(() => ({ userId: "", papel: "ADMIN" as string }));

/**
 * Só `requireAppContext` é substituído. `garantirOrganizacao` vem do módulo REAL pelo
 * espalhamento — é justamente ela que está em teste.
 */
vi.mock("@/lib/tenant", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/tenant")>();
  const { PrismaClient: PC } = await import("@prisma/client");
  const db = new PC();
  return {
    ...real,
    requireAppContext: async () => {
      const user = await db.user.findUniqueOrThrow({ where: { id: contexto.userId } });
      const org = user.organizationId
        ? await db.organization.findUnique({ where: { id: user.organizationId } })
        : await db.organization.findFirst({ where: { ownerId: user.id } });
      return {
        user: { id: user.id, email: user.email, name: user.name, role: contexto.papel },
        organization: org,
        subscription: null,
        currentSubscription: null,
        access: { hasAccess: false, reason: "sem_assinatura", message: "" },
        quota: { unlimited: false, quota: 0, used: 0, extra: 0, remaining: 0, allowed: false },
      };
    },
  };
});

const { garantirOrganizacao } = await import("../src/lib/tenant");
const { POST: CRIAR_ANALISE } = await import("../src/app/api/analises/route");

const prisma = new PrismaClient();
const PREFIXO = "test-org-demanda";

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
}

beforeAll(limpar);
afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await limpar();
  const user = await prisma.user.create({
    data: {
      email: `${PREFIXO}-admin@exemplo.local`,
      name: `${PREFIXO} Sem Organização`,
      passwordHash: "x",
      role: "ADMIN",
    },
  });
  contexto.userId = user.id;
  contexto.papel = "ADMIN";
});

describe("garantirOrganizacao", () => {
  it("cria a organização e amarra a conta como titular", async () => {
    const org = await garantirOrganizacao(contexto.userId, "Escritório de Teste");

    expect(org.ownerId).toBe(contexto.userId);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: contexto.userId } });
    // Sem o papel, a conta ficaria ligada a uma organização em que não tem função.
    expect(user.organizationId).toBe(org.id);
    expect(user.orgRole).toBe("OWNER");
  });

  it("chamada duas vezes devolve a MESMA organização", async () => {
    const primeira = await garantirOrganizacao(contexto.userId, "Escritório de Teste");
    const segunda = await garantirOrganizacao(contexto.userId, "Outro Nome Qualquer");

    expect(segunda.id).toBe(primeira.id);
    // E não cria uma segunda: duas organizações para o mesmo titular partiriam os dados
    // do cliente em dois lugares.
    expect(await prisma.organization.count({ where: { ownerId: contexto.userId } })).toBe(1);
  });
});

describe("criar análise com conta sem organização", () => {
  it("cria a organização em vez de recusar", async () => {
    expect(await prisma.organization.count({ where: { ownerId: contexto.userId } })).toBe(0);

    const res = await CRIAR_ANALISE(
      new Request("http://localhost/api/analises", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identification: { title: "Execução fiscal de teste", type: "PRESCRICAO_INTERCORRENTE" }, facts: {} }),
      }) as never,
    );
    const corpo = await res.json();

    // 201: a rota devolve "criado", e não 200.
    expect(res.status).toBe(201);
    // A análise nasceu ligada à organização recém-criada, não solta.
    const analise = await prisma.analysis.findUniqueOrThrow({ where: { id: corpo.data.id } });
    const org = await prisma.organization.findFirstOrThrow({ where: { ownerId: contexto.userId } });
    expect(analise.organizationId).toBe(org.id);

    await prisma.analysis.deleteMany({ where: { id: analise.id } });
  });
});
