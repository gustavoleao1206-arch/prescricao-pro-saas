import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { processAnalysis } from "../src/lib/analysis-runner";
import { cifrarTextoDaPagina } from "../src/lib/pagina-do-processo";

/**
 * Análise sem texto legível NÃO cobra crédito.
 *
 * ── O defeito ─────────────────────────────────────────────────────────────────
 * O fluxo automático para com 422 e apaga o rascunho quando nenhuma página é legível — sem cobrar. O
 * preenchimento manual não tinha essa trava: chegava ao motor, o motor extraía, cobrava, e só então a IA
 * recebia "nenhum texto extraído". Cliente pagante que subisse só imagem, ou PDF sem camada de texto,
 * pagava por uma análise sobre nada. Encontrado no levantamento de prontidão para vendas de 03/09/2026.
 *
 * A cobrança acontece DEPOIS da extração e ANTES da IA, então a trava fica exatamente entre as duas: sem
 * página com texto, o motor lança, o `catch` externo marca ERRO_PROCESSAMENTO com a mensagem, e nenhum
 * crédito foi tocado. A IA nunca é chamada — e é por isso que este teste não precisa de chave nenhuma.
 */

const prisma = new PrismaClient();

/** Prefixo próprio deste arquivo — não pode começar com o de outro teste (CONTRIBUTING.md). */
const PREFIXO = "test-semtexto";

let subscriptionId = "";
let analysisId = "";

async function limpar(): Promise<void> {
  await prisma.creditLedger.deleteMany({ where: { subscription: { organization: { name: { startsWith: PREFIXO } } } } });
  await prisma.documentPage.deleteMany({ where: { document: { filename: { startsWith: PREFIXO } } } });
  await prisma.document.deleteMany({ where: { filename: { startsWith: PREFIXO } } });
  await prisma.analysis.deleteMany({ where: { title: { startsWith: PREFIXO } } });
  await prisma.subscription.deleteMany({ where: { organization: { name: { startsWith: PREFIXO } } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIXO } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIXO } } });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

beforeAll(async () => {
  await limpar();

  const dono = await prisma.user.create({
    data: { email: `${PREFIXO}@exemplo.local`, name: `${PREFIXO} Dono`, role: "CLIENTE", status: "ATIVO" },
  });
  const org = await prisma.organization.create({ data: { name: `${PREFIXO} Escritorio`, ownerId: dono.id } });
  await prisma.user.update({ where: { id: dono.id }, data: { organizationId: org.id, orgRole: "OWNER" } });

  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-mensal`,
      name: `${PREFIXO} Mensal`,
      description: "plano de teste",
      priceCents: 11990,
      period: "MENSAL",
      family: "PRO",
      monthlyAnalyses: 5,
      maxUsers: 1,
      active: true,
      publicPlan: false,
    },
  });

  const sub = await prisma.subscription.create({
    data: {
      organizationId: org.id,
      planId: plano.id,
      status: "ATIVA",
      provider: "MANUAL",
      amountCents: 11990,
      analysesQuota: 5,
      analysesUsed: 0,
      extraAnalyses: 0,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  subscriptionId = sub.id;

  const analise = await prisma.analysis.create({
    data: { organizationId: org.id, ownerId: dono.id, title: `${PREFIXO} analise`, status: "DOCUMENTOS_ENVIADOS" },
  });
  analysisId = analise.id;

  const doc = await prisma.document.create({
    data: {
      organizationId: org.id,
      analysisId: analise.id,
      filename: `${PREFIXO}-digitalizado.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 10,
      storageKey: `${PREFIXO}/digitalizado.pdf`,
      status: "PROCESSADO",
      pageCount: 2,
    },
  });
  /**
   * Duas páginas "lidas", nenhuma com texto de verdade: só o carimbo do sistema processual, abaixo do corte
   * de 60 caracteres. É o que sobra de um PDF escaneado sem OCR.
   */
  await prisma.documentPage.createMany({
    data: [
      { documentId: doc.id, pageNumber: 1, text: cifrarTextoDaPagina("PJe fl. 1"), legible: false },
      { documentId: doc.id, pageNumber: 2, text: cifrarTextoDaPagina("PJe fl. 2"), legible: false },
    ],
  });
});

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

describe("⚠️ análise sem nenhuma página legível", () => {
  it("o motor recusa com a explicação, marca ERRO_PROCESSAMENTO e não debita crédito", async () => {
    /**
     * O `catch` do motor marca o status, registra a mensagem em `AiUsageRecord` e em auditoria, e RELANÇA
     * — quem chama (fila ou rota) decide o que fazer com o erro. Por isso a promessa rejeita aqui.
     */
    await expect(processAnalysis(analysisId)).rejects.toThrow(/0 de 2 páginas têm texto/);

    const analise = await prisma.analysis.findUniqueOrThrow({ where: { id: analysisId } });
    expect(analise.status).toBe("ERRO_PROCESSAMENTO");

    /**
     * A prova que importa é o extrato: nenhuma linha de CONSUMO para esta análise. Sem a trava, o motor
     * cobrava antes de descobrir que não havia o que analisar — e este contador seria 1.
     */
    const consumos = await prisma.creditLedger.count({ where: { analysisId, kind: "CONSUMO" } });
    expect(consumos).toBe(0);

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(sub.analysesUsed).toBe(0);
  });

  it("a mensagem registrada explica o que fazer e não depende de chave de IA", async () => {
    /** Filtrado pela própria análise, nunca `findFirst` na tabela inteira (CONTRIBUTING.md). */
    const registro = await prisma.aiUsageRecord.findFirst({
      where: { analysisId, errored: true },
      orderBy: { createdAt: "desc" },
    });

    expect(registro).not.toBeNull();
    expect(registro!.errorMessage).toMatch(/Nenhum crédito foi debitado/);
    expect(registro!.errorMessage).toMatch(/PDF original do sistema processual/);
    /** A IA nunca foi chamada: se fosse, a falha aqui seria de credencial, não de leitura. */
    expect(registro!.errorMessage).not.toMatch(/OPENAI|API key|401/i);
  });
});
