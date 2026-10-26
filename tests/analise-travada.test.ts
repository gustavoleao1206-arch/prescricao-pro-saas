import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  destravarAnalisesAbandonadas,
  destravarSeAbandonada,
  MINUTOS_SEM_SINAL_DE_VIDA,
  STATUS_EM_EXECUCAO,
} from "../src/lib/analise-travada";
import { consumirCreditos, saldoDe } from "../src/lib/credits";

/**
 * Análise presa em processamento — e o crédito preso com ela.
 *
 * ── O defeito ─────────────────────────────────────────────────────────────────
 * O crédito é debitado ANTES da chamada de IA (é o único momento em que dá para recusar
 * por saldo sem ter gastado com o provedor), e o estorno automático mora no `catch` de
 * `processAnalysis`. `catch` só roda quando o código lança — não quando o PROCESSO morre:
 * deploy no meio da execução, tempo limite da requisição no modo síncrono, falta de
 * memória, contêiner reiniciado.
 *
 * O que sobrava: status parado em PROCESSANDO, crédito debitado, nenhum estorno, nenhum
 * aviso — e a análise impossível de retomar, porque a rota de processar recusava com 409
 * enquanto o status fosse de processamento. O cliente pagava, não recebia nada, via
 * "processando" para sempre e não tinha nem o botão de tentar de novo.
 *
 * O contrapeso, testado aqui com o mesmo cuidado: execução VIVA não pode ser morta por
 * esta rotina. Errar para o lado curto devolveria crédito de análise que ia terminar.
 */

const prisma = new PrismaClient();
const PREFIXO = "test-travada";

let orgId = "";
let subId = "";
let planoId = "";

const minutosAtras = (n: number) => new Date(Date.now() - n * 60_000);

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orgs = await prisma.organization.findMany({
    where: { OR: [{ name: { startsWith: PREFIXO } }, { ownerId: { in: ids } }] },
    select: { id: true },
  });
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

beforeAll(async () => {
  await limpar();
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-mensal`,
      name: "Mensal (travada)",
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
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org`, ownerId: user.id } });
  orgId = org.id;
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id, orgRole: "OWNER" } });
});

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.analysis.deleteMany({ where: { organizationId: orgId } });
  await prisma.creditLedger.deleteMany({ where: { subscription: { organizationId: orgId } } });
  await prisma.subscription.deleteMany({ where: { organizationId: orgId } });
  const sub = await prisma.subscription.create({
    data: {
      organizationId: orgId,
      planId: planoId,
      status: "ATIVA",
      provider: "ASAAS",
      amountCents: 4990,
      currentPeriodEnd: new Date(Date.now() + 20 * 86400000),
      maxUsers: 1,
      analysesQuota: 20,
    },
  });
  subId = sub.id;
});

/**
 * Análise num estado de execução, com o último sinal de vida há `minutos`.
 *
 * O sinal é `heartbeatAt`, um campo COMUM — dá para gravá-lo pelo Prisma. Era com
 * `updatedAt` que este teste começou, e ele revelou dois problemas de verdade: o campo é
 * `@updatedAt` (o Prisma o sobrescreve em toda escrita, então só SQL cru o define), e
 * gravá-lo por SQL cru numa coluna `timestamp` sem fuso desloca o valor pelo fuso da
 * máquina — três horas, aqui, o que fazia execução VIVA parecer abandonada. O campo
 * próprio resolve o teste e o desenho ao mesmo tempo.
 */
async function analiseEmExecucao(opcoes: {
  minutosSemSinal: number;
  status?: (typeof STATUS_EM_EXECUCAO)[number];
  creditos?: number;
}) {
  const dono = await prisma.user.findFirstOrThrow({ where: { email: { startsWith: PREFIXO } } });
  const analise = await prisma.analysis.create({
    data: {
      organizationId: orgId,
      ownerId: dono.id,
      title: `${PREFIXO} análise`,
      type: "PRESCRICAO_INTERCORRENTE",
      status: opcoes.status ?? "PROCESSANDO",
    },
  });
  if (opcoes.creditos) await consumirCreditos(subId, analise.id, opcoes.creditos);
  // Depois do consumo, porque ele também escreve na análise (creditsCharged).
  return prisma.analysis.update({
    where: { id: analise.id },
    data: { heartbeatAt: minutosAtras(opcoes.minutosSemSinal) },
  });
}

const lerAnalise = (id: string) => prisma.analysis.findUniqueOrThrow({ where: { id } });
const lerSub = () => prisma.subscription.findUniqueOrThrow({ where: { id: subId } });

describe("destrave sob demanda", () => {
  it("devolve o crédito e libera a análise para nova tentativa", async () => {
    const analise = await analiseEmExecucao({ minutosSemSinal: MINUTOS_SEM_SINAL_DE_VIDA + 5, creditos: 2 });
    expect(saldoDe(await lerSub()).total).toBe(18);

    const r = await destravarSeAbandonada(analise.id);

    expect(r.destravada).toBe(true);
    expect(r.creditosEstornados).toBe(2);
    // O crédito volta: o cliente não paga por processo que morreu do nosso lado.
    expect(saldoDe(await lerSub()).total).toBe(20);
    // E o estado deixa de ser "processando", que é o que impedia tentar de novo.
    expect((await lerAnalise(analise.id)).status).toBe("ERRO_PROCESSAMENTO");
  });

  it("a nova tentativa NÃO conta como reprocessamento", async () => {
    const analise = await analiseEmExecucao({ minutosSemSinal: MINUTOS_SEM_SINAL_DE_VIDA + 5, creditos: 1 });

    await destravarSeAbandonada(analise.id);

    /**
     * `creditsCharged` zerado é o que faz a rota de processar não contar esta tentativa
     * como reprocesso. Queda de servidor não é o cliente pedindo reexecução, e não pode
     * gastar o limite de reprocessos dele.
     */
    expect((await lerAnalise(analise.id)).creditsCharged).toBe(0);
  });

  it("NÃO mexe em execução viva — o sinal de vida é recente", async () => {
    const analise = await analiseEmExecucao({ minutosSemSinal: 2, creditos: 2 });

    const r = await destravarSeAbandonada(analise.id);

    expect(r.destravada).toBe(false);
    // Nada de devolver crédito de análise que ainda vai terminar.
    expect(saldoDe(await lerSub()).total).toBe(18);
    expect((await lerAnalise(analise.id)).status).toBe("PROCESSANDO");
  });

  it("não toca em análise que já terminou", async () => {
    const dono = await prisma.user.findFirstOrThrow({ where: { email: { startsWith: PREFIXO } } });
    const analise = await prisma.analysis.create({
      data: {
        organizationId: orgId,
        ownerId: dono.id,
        title: `${PREFIXO} concluída`,
        type: "PRESCRICAO_INTERCORRENTE",
        status: "AGUARDANDO_REVISAO",
      },
    });
    await consumirCreditos(subId, analise.id, 1);
    await prisma.analysis.update({ where: { id: analise.id }, data: { heartbeatAt: minutosAtras(600) } });

    const r = await destravarSeAbandonada(analise.id);

    expect(r.destravada).toBe(false);
    // Análise entregue não devolve crédito por estar parada há muito tempo.
    expect(saldoDe(await lerSub()).total).toBe(19);
  });

  it("é idempotente: destravar duas vezes não credita duas vezes", async () => {
    const analise = await analiseEmExecucao({ minutosSemSinal: MINUTOS_SEM_SINAL_DE_VIDA + 5, creditos: 3 });

    await destravarSeAbandonada(analise.id);
    const segunda = await destravarSeAbandonada(analise.id);

    expect(segunda.destravada).toBe(false);
    expect(saldoDe(await lerSub()).total).toBe(20);
  });

  it("vale para as três etapas de execução, não só PROCESSANDO", async () => {
    for (const status of STATUS_EM_EXECUCAO) {
      const analise = await analiseEmExecucao({ minutosSemSinal: MINUTOS_SEM_SINAL_DE_VIDA + 1, status });
      const r = await destravarSeAbandonada(analise.id);
      expect(r.destravada, `status ${status} ficou preso`).toBe(true);
    }
  });
});

describe("varredura da manutenção", () => {
  it("destrava quem nunca voltou à tela e soma os créditos devolvidos", async () => {
    const a = await analiseEmExecucao({ minutosSemSinal: MINUTOS_SEM_SINAL_DE_VIDA + 10, creditos: 2 });
    const b = await analiseEmExecucao({ minutosSemSinal: MINUTOS_SEM_SINAL_DE_VIDA + 90, creditos: 1 });
    const viva = await analiseEmExecucao({ minutosSemSinal: 1, creditos: 1 });

    const r = await destravarAnalisesAbandonadas();

    // Afirma sobre as PRÓPRIAS análises: a varredura é global e a suíte roda em
    // paralelo sobre o mesmo banco.
    expect(r.ids).toContain(a.id);
    expect(r.ids).toContain(b.id);
    expect(r.ids).not.toContain(viva.id);
    expect((await lerAnalise(viva.id)).status).toBe("PROCESSANDO");
    // 2 + 1 devolvidos; a viva segue com o dela debitado.
    expect(saldoDe(await lerSub()).total).toBe(19);
  });

  it("registra na auditoria o que foi destravado", async () => {
    const analise = await analiseEmExecucao({ minutosSemSinal: MINUTOS_SEM_SINAL_DE_VIDA + 5, creditos: 1 });

    await destravarAnalisesAbandonadas();

    const registro = await prisma.auditLog.findFirst({
      where: { action: "analysis.execucao_abandonada", entityId: analise.id },
    });
    expect(registro).not.toBeNull();
  });
});
