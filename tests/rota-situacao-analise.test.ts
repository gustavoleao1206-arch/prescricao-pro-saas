import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * As rotas que dão saída à análise emperrada — e a trava de cobrança que elas criaram.
 *
 * ── O que não existia ─────────────────────────────────────────────────────────
 * Nenhuma ação sobre situação de análise. A tela do administrador era uma tabela de leitura, e a única
 * rota capaz de mudar o status (`PATCH /api/analises/[id]`) não tinha chamador, não validava transição e
 * ignorava crédito. Para o cliente com análise em erro e o limite de reprocessamentos esgotado, o único
 * botão restante era EXCLUIR — que apaga os documentos e não devolve nada.
 *
 * ── A cobrança indevida que o conserto abriria, se não fosse travada ──────────
 * Cancelar devolve o crédito quando não houve entrega. E a idempotência da cobrança pergunta se existe
 * consumo NÃO ESTORNADO, de propósito, para a análise que falhou e foi estornada poder ser cobrada de
 * novo quando o cliente reexecuta. Juntas, as duas regras deixavam passar isto: o cliente cancela,
 * recebe o crédito, clica em "Reprocessar" e é debitado OUTRA VEZ por uma análise que ele encerrou.
 *
 * O último bloco deste arquivo é essa trava, e é o teste que mais importa aqui.
 */

const contexto = vi.hoisted(() => ({
  userId: "",
  orgId: "",
  subId: "",
  papel: "CLIENTE" as string,
  adminId: "",
  papelAdmin: "ADMIN" as string,
}));
const fila = vi.hoisted(() => ({ chamadas: [] as string[] }));

/** A fila é substituída: o que se mede é a decisão da rota, não o motor de IA. */
vi.mock("@/lib/queue/queue", () => ({
  enqueueAnalysis: async (analysisId: string) => {
    fila.chamadas.push(analysisId);
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

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    requireRole: async (...papeis: string[]) => {
      if (!papeis.includes(contexto.papelAdmin)) throw new real.AuthError("Acesso negado", 403);
      return { id: contexto.adminId, email: "admin@teste.local", name: "Admin", role: contexto.papelAdmin };
    },
  };
});

const { POST: SITUACAO } = await import("../src/app/api/analises/[id]/situacao/route");
const { PATCH: SITUACAO_ADMIN } = await import("../src/app/api/admin/analises/[id]/situacao/route");
const { POST: PROCESSAR } = await import("../src/app/api/analises/[id]/processar/route");
const { consumirCreditos } = await import("../src/lib/credits");
const { MINUTOS_SEM_SINAL_DE_VIDA } = await import("../src/lib/analise-travada");

const prisma = new PrismaClient();
const PREFIXO = "test-rota-situacao";

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orgs = await prisma.organization.findMany({
    where: { OR: [{ name: { startsWith: PREFIXO } }, { ownerId: { in: ids } }] },
    select: { id: true },
  });
  const analises = orgs.length
    ? await prisma.analysis.findMany({ where: { organizationId: { in: orgs.map((o) => o.id) } }, select: { id: true } })
    : [];
  if (analises.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: analises.map((a) => a.id) } } });
  }
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

let planoId = "";

beforeAll(async () => {
  await limpar();
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-mensal`,
      name: "Mensal (situação)",
      priceCents: 4990,
      period: "MENSAL",
      monthlyAnalyses: 20,
      maxUsers: 1,
    },
  });
  planoId = plano.id;

  const admin = await prisma.user.create({
    data: { email: `${PREFIXO}-admin@exemplo.local`, name: "Admin", passwordHash: "x", role: "ADMIN" },
  });
  contexto.adminId = admin.id;
});

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

beforeEach(async () => {
  fila.chamadas = [];
  contexto.papel = "CLIENTE";
  contexto.papelAdmin = "ADMIN";

  const user = await prisma.user.create({
    data: {
      email: `${PREFIXO}-cliente-${Date.now()}-${Math.round(performance.now() * 1000)}@exemplo.local`,
      name: "Cliente da Silva",
      passwordHash: "x",
      role: "CLIENTE",
    },
  });
  contexto.userId = user.id;
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org`, ownerId: user.id } });
  contexto.orgId = org.id;
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id, orgRole: "OWNER" } });

  const sub = await prisma.subscription.create({
    data: {
      organizationId: org.id,
      planId: planoId,
      status: "ATIVA",
      provider: "MANUAL",
      amountCents: 4990,
      analysesQuota: 20,
      analysesUsed: 0,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  contexto.subId = sub.id;
});

async function analise(
  status: "RASCUNHO" | "ERRO_PROCESSAMENTO" | "PROCESSANDO" | "CONCLUIDA" | "ARQUIVADA" = "ERRO_PROCESSAMENTO",
  extra: { heartbeatAt?: Date | null; completedAt?: Date | null } = {},
) {
  return prisma.analysis.create({
    data: {
      organizationId: contexto.orgId,
      ownerId: contexto.userId,
      title: `${PREFIXO} análise`,
      status,
      heartbeatAt: extra.heartbeatAt ?? null,
      completedAt: extra.completedAt ?? null,
    },
  });
}

const pedido = (corpo: unknown, metodo = "POST") =>
  new Request("http://localhost/api/analises/x/situacao", {
    method: metodo,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  }) as never;

const usado = async () => (await prisma.subscription.findUniqueOrThrow({ where: { id: contexto.subId } })).analysesUsed;

describe("o cliente cancela a própria análise", () => {
  it("⚠️ cancela, devolve o crédito e DIZ que devolveu", async () => {
    /**
     * A mensagem tem de falar do dinheiro. Cancelar é a ação de quem pagou e não recebeu: se a tela só
     * disser "análise cancelada", a dúvida sobre o crédito vira chamado de suporte no melhor caso e
     * pedido de estorno no cartão no pior.
     */
    const a = await analise("ERRO_PROCESSAMENTO");
    await consumirCreditos(contexto.subId, a.id, 1, "Análise de teste");
    expect(await usado()).toBe(1);

    const res = await SITUACAO(pedido({ acao: "cancelar" }), { params: Promise.resolve({ id: a.id }) });
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.status).toBe("CANCELADA");
    expect(corpo.data.creditosDevolvidos).toBe(1);
    /**
     * ⚠️ "devolvido", não "crédito". A asserção anterior era `toContain("crédito")` — e a palavra
     * "crédito" aparece nas QUATRO mensagens de cancelamento, inclusive nas duas que NEGAM a devolução.
     * A revisão provou por sabotagem: removendo o ramo que anuncia a devolução, a resposta passava a
     * dizer "não havia crédito debitado nesta análise" e o teste continuava verde.
     */
    expect(corpo.data.message).toContain("devolvido");
    expect(await usado()).toBe(0);
  });

  it("⚠️ com relatório, a resposta EXPLICA por que não devolveu", async () => {
    /**
     * O outro ramo da mensagem, também sem cobertura. Sem o motivo escrito, a ausência da devolução
     * parece falha do sistema — e a pessoa reclama do que é regra.
     */
    const a = await analise("ERRO_PROCESSAMENTO");
    await consumirCreditos(contexto.subId, a.id, 1, "Análise de teste");
    await prisma.report.create({ data: { analysisId: a.id, version: 1, markdown: "relatório", content: {} } });

    const corpo = await (await SITUACAO(pedido({ acao: "cancelar" }), { params: Promise.resolve({ id: a.id }) })).json();

    expect(corpo.data.creditosDevolvidos).toBe(0);
    expect(corpo.data.message).toContain("não é devolvido");
    expect(corpo.data.message).toContain("relatório");
    expect(await usado()).toBe(1);
  });

  it("arquivar diz onde a análise foi parar", async () => {
    /**
     * A análise sai da lista: sem dizer para onde, quem arquivou por engano não acha o caminho de volta.
     */
    const a = await analise("CONCLUIDA", { completedAt: new Date() });

    const corpo = await (await SITUACAO(pedido({ acao: "arquivar" }), { params: Promise.resolve({ id: a.id }) })).json();

    expect(corpo.data.status).toBe("ARQUIVADA");
    expect(corpo.data.message).toContain("Arquivadas");
  });

  it("execução VIVA é recusada com 409 e motivo próprio", async () => {
    /**
     * 409, não 422: o pedido está correto e a ação existe — é o estado que não permite, e meia hora
     * depois a mesma ação passa.
     */
    const a = await analise("PROCESSANDO", { heartbeatAt: new Date() });

    const res = await SITUACAO(pedido({ acao: "cancelar" }), { params: Promise.resolve({ id: a.id }) });

    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("execucao_viva");
  });

  it("execução MORTA é cancelável — é onde cancelar tem valor", async () => {
    const a = await analise("PROCESSANDO", {
      heartbeatAt: new Date(Date.now() - (MINUTOS_SEM_SINAL_DE_VIDA + 5) * 60_000),
    });

    expect((await SITUACAO(pedido({ acao: "cancelar" }), { params: Promise.resolve({ id: a.id }) })).status).toBe(200);
  });

  it("⚠️ análise de OUTRA pessoa é recusada", async () => {
    const a = await analise("ERRO_PROCESSAMENTO");
    // O contexto passa a ser de um cliente diferente, sem organização em comum.
    const outro = await prisma.user.create({
      data: { email: `${PREFIXO}-outro-${Date.now()}@exemplo.local`, name: "Outro", passwordHash: "x", role: "CLIENTE" },
    });
    const orgDoOutro = await prisma.organization.create({ data: { name: `${PREFIXO}-org2`, ownerId: outro.id } });
    contexto.userId = outro.id;
    contexto.orgId = orgDoOutro.id;

    const res = await SITUACAO(pedido({ acao: "cancelar" }), { params: Promise.resolve({ id: a.id }) });

    /** 404 e não 403: para quem não tem acesso, a análise não existe — nem o id se confirma. */
    expect(res.status).toBe(404);
    expect((await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("ERRO_PROCESSAMENTO");
  });

  it("⚠️ COLEGA da mesma organização não cancela a análise alheia", async () => {
    /**
     * O caminho que faltava: `getAnalysisForContext` LIBERA a leitura para quem é da mesma organização,
     * então a guarda de dono da rota é a única barreira — e ela não tinha teste. O teste vizinho troca
     * também a organização, e por isso cai no 404 antes de chegar aqui, o que dava a impressão de
     * cobertura.
     *
     * Ler a análise do escritório é uma coisa; encerrar a análise que outra pessoa pagou e vai
     * protocolar é outra.
     */
    const a = await analise("ERRO_PROCESSAMENTO");
    const colega = await prisma.user.create({
      data: {
        email: `${PREFIXO}-colega-${Date.now()}@exemplo.local`,
        name: "Colega",
        passwordHash: "x",
        role: "CLIENTE",
        organizationId: contexto.orgId,
        orgRole: "MEMBRO",
      },
    });
    // MESMA organização, dono diferente.
    contexto.userId = colega.id;

    const res = await SITUACAO(pedido({ acao: "cancelar" }), { params: Promise.resolve({ id: a.id }) });

    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("sem_permissao");
    expect((await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("ERRO_PROCESSAMENTO");
  });

  it("ação inválida não vira alteração nenhuma", async () => {
    const a = await analise("ERRO_PROCESSAMENTO");

    const res = await SITUACAO(pedido({ acao: "apagar-tudo" }), { params: Promise.resolve({ id: a.id }) });

    expect(res.status).toBe(422);
    expect((await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("ERRO_PROCESSAMENTO");
  });
});

describe("o atendimento age sobre a análise do cliente", () => {
  it("cancela em nome do cliente e diz o NOME de quem teve o saldo mexido", async () => {
    /**
     * Agir sobre a conta de outra pessoa sem ver o nome dela na resposta é como se erra o cliente na
     * pressa do atendimento — e aqui o erro move o saldo de alguém.
     */
    const a = await analise("ERRO_PROCESSAMENTO");
    await consumirCreditos(contexto.subId, a.id, 1, "Análise de teste");

    const res = await SITUACAO_ADMIN(pedido({ tipo: "acao", acao: "cancelar" }, "PATCH"), { params: Promise.resolve({ id: a.id }) });
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.creditosDevolvidos).toBe(1);
    expect(corpo.data.message).toContain("Cliente da Silva");
    expect(await usado()).toBe(0);
  });

  it("⚠️ forçar CONCLUIDA sem relatório é recusado", async () => {
    /**
     * O selo verde diria ao cliente que o resultado está pronto e não haveria nada para ler nem baixar.
     */
    const a = await analise("ERRO_PROCESSAMENTO");

    const res = await SITUACAO_ADMIN(
      pedido({ tipo: "forcar", status: "CONCLUIDA", motivo: "cliente pediu por telefone" }, "PATCH"),
      { params: Promise.resolve({ id: a.id }) },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("concluida_sem_relatorio");
  });

  it("forçar sem motivo é recusado antes de tocar no banco", async () => {
    const a = await analise("ERRO_PROCESSAMENTO");

    const res = await SITUACAO_ADMIN(pedido({ tipo: "forcar", status: "RASCUNHO", motivo: "ok" }, "PATCH"), {
      params: Promise.resolve({ id: a.id }),
    });

    expect(res.status).toBe(422);
    expect((await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("ERRO_PROCESSAMENTO");
  });

  it("forçar um status válido funciona, e a resposta diz que NÃO mexeu em crédito", async () => {
    /**
     * Dito em toda resposta de propósito: quem força status está consertando exibição, e a pessoa
     * precisa saber que devolver crédito continua sendo ação separada.
     */
    const a = await analise("ERRO_PROCESSAMENTO");
    await consumirCreditos(contexto.subId, a.id, 1, "Análise de teste");

    const res = await SITUACAO_ADMIN(
      pedido({ tipo: "forcar", status: "AGUARDANDO_INFORMACOES", motivo: "cliente vai reenviar a CDA" }, "PATCH"),
      { params: Promise.resolve({ id: a.id }) },
    );
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.status).toBe("AGUARDANDO_INFORMACOES");
    expect(corpo.data.creditosDevolvidos).toBe(0);
    expect(corpo.data.message).toContain("Nenhum crédito");
    expect(await usado()).toBe(1);
  });

  it("⚠️ a rota do ADMIN também recusa execução VIVA", async () => {
    /**
     * ⚠️ ESTE TESTE FALTAVA, E A REVISÃO PROVOU QUE FALTAVA: apagando a guarda `podeExecutar` da rota do
     * administrador, os 34 testes passavam. Todos os testes de admin usavam análise em
     * ERRO_PROCESSAMENTO, que passa pela guarda — a recusa não era exercitada em lugar nenhum. E a guarda
     * equivalente na rota do CLIENTE está coberta, o que dava a falsa impressão de que as duas estavam.
     *
     * O dano sem a guarda é análise de graça com o dinheiro saindo da Leão Amorim: a rota cancelaria e
     * ESTORNARIA o crédito, o motor — que segue rodando noutro lugar — gravaria o resultado minutos
     * depois, e o cliente ficaria com o relatório entregue E com o crédito de volta no saldo.
     */
    const a = await analise("PROCESSANDO", { heartbeatAt: new Date() });
    await consumirCreditos(contexto.subId, a.id, 1, "Análise de teste");

    const res = await SITUACAO_ADMIN(pedido({ tipo: "acao", acao: "cancelar" }, "PATCH"), { params: Promise.resolve({ id: a.id }) });

    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("execucao_viva");
    // O crédito NÃO foi devolvido, e a análise segue processando.
    expect(await usado()).toBe(1);
    expect((await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("PROCESSANDO");
  });

  it("⚠️ forçar status é recusado durante execução VIVA", async () => {
    const a = await analise("PROCESSANDO", { heartbeatAt: new Date() });

    const res = await SITUACAO_ADMIN(
      pedido({ tipo: "forcar", status: "ERRO_PROCESSAMENTO", motivo: "cliente reclamou da demora" }, "PATCH"),
      { params: Promise.resolve({ id: a.id }) },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("execucao_viva");
  });

  it("⚠️ quem NÃO é ADMIN não passa", async () => {
    const a = await analise("ERRO_PROCESSAMENTO");
    contexto.papelAdmin = "SUPORTE";

    const res = await SITUACAO_ADMIN(pedido({ tipo: "acao", acao: "cancelar" }, "PATCH"), { params: Promise.resolve({ id: a.id }) });

    expect(res.status).toBe(403);
    expect((await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("ERRO_PROCESSAMENTO");
  });
});

describe("⚠️ excluir registra o crédito que jogou fora", () => {
  it("⚠️ a auditoria guarda quanto crédito a exclusão descartou, e o título", async () => {
    /**
     * Excluir não devolve crédito — decisão do dono, e a tela avisa quando há crédito em jogo. Mas o
     * aviso é um `confirm()` que ninguém prova depois: sem este registro, o cliente que reclamar "perdi
     * um crédito" não tem como ser respondido.
     *
     * ⚠️ E o rastro TEM de estar aqui, porque a exclusão apaga a análise e as linhas da razão perdem o
     * vínculo com ela (`onDelete: SetNull`). Depois do DELETE não há mais como reconstituir o número — nem
     * o título, que some com a linha.
     */
    const { DELETE: EXCLUIR } = await import("../src/app/api/analises/[id]/route");
    const a = await analise("ERRO_PROCESSAMENTO");
    await consumirCreditos(contexto.subId, a.id, 2, "Análise de teste");

    const res = await EXCLUIR(pedido({}, "DELETE"), { params: Promise.resolve({ id: a.id }) });
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.creditoDescartado).toBe(2);
    expect(await prisma.analysis.count({ where: { id: a.id } })).toBe(0);

    const registro = await prisma.auditLog.findFirstOrThrow({
      where: { action: "analysis.delete", entityId: a.id },
    });
    const meta = registro.metadata as Record<string, unknown>;
    expect(meta.creditoDescartado).toBe(2);
    expect(meta.titulo).toContain(PREFIXO);

    /** A razão sobrevive, mas SEM o vínculo — é isto que torna o registro acima a única fonte. */
    const linhas = await prisma.creditLedger.findMany({ where: { subscriptionId: contexto.subId } });
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas.every((l) => l.analysisId === null)).toBe(true);
  });

  it("sem crédito em aberto, o registro grava zero — e a tela não avisa nada", async () => {
    const { DELETE: EXCLUIR } = await import("../src/app/api/analises/[id]/route");
    const a = await analise("RASCUNHO");

    const corpo = await (await EXCLUIR(pedido({}, "DELETE"), { params: Promise.resolve({ id: a.id }) })).json();

    expect(corpo.data.creditoDescartado).toBe(0);
  });
});

describe("⚠️ análise encerrada NÃO volta a processar — a trava de cobrança", () => {
  it("cancelar devolve o crédito, e reprocessar depois é RECUSADO", async () => {
    /**
     * A asserção que fecha a cobrança indevida. Sem esta trava: o cliente cancela, recebe o crédito de
     * volta, clica em "Reprocessar" — e é debitado outra vez por uma análise que ele mesmo encerrou. A
     * idempotência da cobrança não segura, porque ela pergunta se existe consumo NÃO ESTORNADO, e o
     * cancelamento acabou de estornar.
     */
    const a = await analise("ERRO_PROCESSAMENTO");
    await consumirCreditos(contexto.subId, a.id, 1, "Análise de teste");
    await SITUACAO(pedido({ acao: "cancelar" }), { params: Promise.resolve({ id: a.id }) });
    expect(await usado()).toBe(0);

    const res = await PROCESSAR(pedido({}), { params: Promise.resolve({ id: a.id }) });

    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("analise_encerrada");
    /**
     * ⚠️ HONESTIDADE SOBRE O QUE ESTE TESTE MEDE: a fila está substituída, então o débito em si
     * acontece dentro do trabalho e não é observável aqui. O que se afirma é o elo que o previne —
     * NADA foi enfileirado. Sem enfileiramento não há execução, e sem execução não há cobrança.
     * Medir o débito exigiria rodar o motor, que precisa de provedor de IA e de armazenamento; o bloco
     * seguinte fecha essa ponta pelo outro lado, chamando o motor direto.
     */
    expect(fila.chamadas).toHaveLength(0);
    /**
     * Uma linha de CONSUMO só na razão. `expect(usado()).toBe(0)` aqui não poderia falhar — o
     * cancelamento já a havia deixado em zero na asserção acima —, enquanto uma segunda cobrança
     * apareceria nesta contagem.
     */
    expect(await prisma.creditLedger.count({ where: { analysisId: a.id, kind: "CONSUMO" } })).toBe(1);
    expect((await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("CANCELADA");
  });

  it("análise ARQUIVADA também é recusada, e a mensagem diz o caminho", async () => {
    const a = await analise("ARQUIVADA", { completedAt: new Date() });

    const res = await PROCESSAR(pedido({}), { params: Promise.resolve({ id: a.id }) });
    const corpo = await res.json();

    expect(res.status).toBe(409);
    expect(corpo.error).toContain("Desarquive");
    expect(fila.chamadas).toHaveLength(0);
  });

  it("⚠️ O MOTOR também recusa: cancelada entre enfileirar e executar não é cobrada", async () => {
    /**
     * A trava que de fato protege o caixa, e ela não está na rota.
     *
     * A fila é um SEGUNDO caminho até o motor: entre enfileirar e o trabalho rodar passa tempo, e nessa
     * janela o cliente pode cancelar. Sem a recusa dentro de `processAnalysis`, o trabalho rodaria,
     * chamaria a IA (custo real, pago pela Leão Amorim) e debitaria o crédito que o cancelamento acabou
     * de devolver — cobrança que o cliente não reconhece numa análise que ele encerrou.
     *
     * Aqui o motor é chamado DIRETO, sem fila: se a recusa não existisse, este teste explodiria por falta
     * de provedor de IA em vez de passar — o que também serve de prova de que ele nem chega lá.
     */
    const { processAnalysis } = await import("../src/lib/analysis-runner");
    const a = await analise("ERRO_PROCESSAMENTO");
    await consumirCreditos(contexto.subId, a.id, 1, "Análise de teste");
    await SITUACAO(pedido({ acao: "cancelar" }), { params: Promise.resolve({ id: a.id }) });

    // Não lança: ordem revogada não é falha. Lançar marcaria ERRO_PROCESSAMENTO por cima do CANCELADA.
    await expect(processAnalysis(a.id, { cobrarCliente: true })).resolves.toBeUndefined();

    const depois = await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } });
    expect(depois.status).toBe("CANCELADA");
    expect(await usado()).toBe(0);
    expect(await prisma.creditLedger.count({ where: { analysisId: a.id, kind: "CONSUMO" } })).toBe(1);
  });

  it("⚠️ subir documento não RESSUSCITA análise cancelada", async () => {
    /**
     * O envio de documento gravava `status: "DOCUMENTOS_ENVIADOS"` sem olhar o status atual — o que
     * desfazia o cancelamento em silêncio e devolvia a análise ao fluxo, contornando a trava de
     * reprocessamento só com um upload.
     *
     * O teste bate na guarda, sem armazenamento: a recusa vem antes de qualquer escrita.
     */
    const { POST: ENVIAR } = await import("../src/app/api/documentos/route");
    const a = await analise("ERRO_PROCESSAMENTO");
    await SITUACAO(pedido({ acao: "cancelar" }), { params: Promise.resolve({ id: a.id }) });

    const form = new FormData();
    form.set("analysisId", a.id);
    form.set("file", new File([new Uint8Array([37, 80, 68, 70])], "processo.pdf", { type: "application/pdf" }));
    const res = await ENVIAR(
      new Request("http://localhost/api/documentos", { method: "POST", body: form }) as never,
    );

    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("analise_encerrada");
    expect((await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("CANCELADA");
    expect(await prisma.document.count({ where: { analysisId: a.id } })).toBe(0);
  });

  it("desarquivar devolve a análise ao fluxo, e então ela processa", async () => {
    /**
     * Sem este caminho, arquivar seria via de mão única e o cliente perderia a análise no arquivo.
     *
     * O arquivamento passa pela ROTA de propósito: é ele que grava o registro de auditoria de onde o
     * desarquivamento tira o status de origem. Montar ARQUIVADA à mão faz a análise voltar como
     * CANCELADA — o padrão conservador para quem não tem registro — e é o comportamento correto.
     */
    const a = await analise("CONCLUIDA", { completedAt: new Date() });
    expect((await SITUACAO(pedido({ acao: "arquivar" }), { params: Promise.resolve({ id: a.id }) })).status).toBe(200);

    await SITUACAO(pedido({ acao: "desarquivar" }), { params: Promise.resolve({ id: a.id }) });
    expect((await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("CONCLUIDA");

    expect((await PROCESSAR(pedido({}), { params: Promise.resolve({ id: a.id }) })).status).toBe(200);
    expect(fila.chamadas).toHaveLength(1);
  });

  it("⚠️ reprocessar renova o sinal de vida — a análise não nasce 'abandonada'", async () => {
    /**
     * `semSinalDeVida` usa `heartbeatAt` quando ele existe, e numa análise que já rodou ele é da execução
     * ANTERIOR. Sem renovar aqui, no segundo seguinte ao enfileiramento a análise já satisfazia o
     * critério de "morta há mais de 30 minutos" — com dois efeitos de dinheiro: a varredura de manutenção
     * matava execução VIVA e devolvia o crédito de uma análise que ia terminar, e o botão "Cancelar
     * análise" aparecia no meio do processamento, deixando o cliente cancelar, receber o crédito de volta
     * e ainda assim receber o relatório minutos depois.
     */
    const antigo = new Date(Date.now() - (MINUTOS_SEM_SINAL_DE_VIDA + 60) * 60_000);
    const a = await analise("ERRO_PROCESSAMENTO", { heartbeatAt: antigo, completedAt: new Date() });

    expect((await PROCESSAR(pedido({}), { params: Promise.resolve({ id: a.id }) })).status).toBe(200);

    const depois = await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } });
    expect(depois.status).toBe("PROCESSANDO");
    expect(depois.heartbeatAt!.getTime()).toBeGreaterThan(antigo.getTime());
    // E com o sinal renovado, cancelar é recusado: a execução é considerada VIVA.
    const res = await SITUACAO(pedido({ acao: "cancelar" }), { params: Promise.resolve({ id: a.id }) });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("execucao_viva");
  });
});
