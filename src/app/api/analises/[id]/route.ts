import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireAppContext, getAnalysisForContext } from "@/lib/tenant";
import { removeObject } from "@/lib/storage";
import { creditoDevolvivel } from "@/lib/credits";
import { logAudit, logLeitura } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit";
import { z } from "zod";

export const GET = route(async (req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const ctx = await requireAppContext();
  const analysis = await getAnalysisForContext(params.id, ctx, true);
  if (!analysis) return fail("Análise não encontrada.", 404);

  /**
   * ⚠️ ESTA ROTA ENTREGA OS AUTOS INTEIROS, e não registrava nada.
   *
   * O terceiro parâmetro `true` puxa documentos, linha do tempo, relatórios, minutas e a revisão — o
   * conteúdo integral do processo, em texto puro. E `getAnalysisForContext` libera ADMIN e REVISOR para
   * QUALQUER análise: bastava um GET autenticado por id para extrair o processo de qualquer assinante, sem
   * deixar uma linha.
   *
   * A Política de Privacidade publicada promete registro para "download de documento, de relatório e de
   * peça" — e é exatamente relatório e peça que saem por aqui. Sem este registro, o produto prometia um
   * controle que não existia neste caminho.
   */
  await logLeitura({
    actorId: ctx.user.id,
    actorRole: ctx.user.role,
    action: "analysis.read",
    entityType: "Analysis",
    entityId: params.id,
    metadata: { própriaConta: analysis.ownerId === ctx.user.id },
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent") ?? undefined,
  });

  return ok({ analysis });
});

/**
 * ⚠️ `status` SAIU DAQUI, e a remoção é o conserto de um caminho perigoso sem uso.
 *
 * O campo aceitava ARQUIVADA, CANCELADA e AGUARDANDO_INFORMACOES e gravava direto, sem NADA: sem
 * conferir de qual status a análise vinha, sem tocar em crédito e sem registrar a mudança em auditoria.
 * Nunca teve um chamador — nenhuma tela do produto o usava —, e é por isso que os três status nunca
 * apareciam em análise nenhuma.
 *
 * Deixá-lo agora seria pior que antes: uma segunda porta para mudar situação de análise, com regras
 * diferentes da porta oficial. Cancelar por aqui não devolveria o crédito de quem pagou e não recebeu,
 * e ninguém saberia dizer depois quem cancelou nem quando.
 *
 * A porta oficial é `POST /api/analises/[id]/situacao` (cliente) e
 * `PATCH /api/admin/analises/[id]/situacao` (atendimento), com as regras em
 * `src/lib/situacao-da-analise.ts`. Este PATCH volta a ser o que sempre deveria ter sido: edição de
 * título, objetivo e datas informadas.
 */
const patchSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  objective: z.string().max(2000).optional(),
  facts: z.record(z.string(), z.any()).optional(),
});

export const PATCH = route(async (req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const ctx = await requireAppContext();
  const analysis = await getAnalysisForContext(params.id, ctx);
  if (!analysis) return fail("Análise não encontrada.", 404);
  if (analysis.ownerId !== ctx.user.id && ctx.user.role !== "ADMIN") return fail("Sem permissão.", 403);

  const data = patchSchema.parse(await req.json());
  const updated = await prisma.analysis.update({
    where: { id: params.id },
    data: {
      title: data.title,
      objective: data.objective,
      facts: data.facts ? (data.facts as object) : undefined,
    },
  });
  await logAudit({ actorId: ctx.user.id, action: "analysis.update", entityType: "Analysis", entityId: params.id, metadata: { fields: Object.keys(data) } });
  return ok({ id: updated.id, status: updated.status });
});

export const DELETE = route(async (_req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const ctx = await requireAppContext();
  const analysis = await getAnalysisForContext(params.id, ctx, true);
  if (!analysis) return fail("Análise não encontrada.", 404);
  if (analysis.ownerId !== ctx.user.id && ctx.user.role !== "ADMIN") return fail("Sem permissão.", 403);

  // Remove os arquivos do armazenamento privado antes de apagar os registros.
  const docs = "documents" in analysis ? (analysis.documents as { storageKey: string }[]) : [];
  for (const d of docs) {
    try {
      await removeObject(d.storageKey);
    } catch {
      /* segue mesmo se um objeto já não existir */
    }
  }
  /**
   * ⚠️ MEDIDO ANTES DE APAGAR: quanto crédito esta exclusão está jogando fora.
   *
   * Excluir não devolve crédito — decisão do dono, e a tela avisa quando há crédito em jogo. Mas o aviso
   * é um `confirm()` que ninguém prova depois: sem este registro, o cliente que reclamar "perdi um
   * crédito" não tem como ser respondido, porque a exclusão apaga a análise E as linhas da razão perdem o
   * vínculo com ela (`onDelete: SetNull`). O número tem de ser lido enquanto a análise existe.
   *
   * Zero é o caso normal (nada cobrado, ou o crédito já devolvido, ou trabalho entregue).
   */
  const creditoDescartado = await creditoDevolvivel(params.id);

  await prisma.analysis.delete({ where: { id: params.id } });
  await logAudit({
    actorId: ctx.user.id,
    action: "analysis.delete",
    entityType: "Analysis",
    entityId: params.id,
    metadata: {
      creditoDescartado,
      /** O título some com a análise; guardá-lo é o que permite reconhecer o caso num atendimento. */
      titulo: analysis.title,
    },
  });
  return ok({ deleted: true, creditoDescartado });
});
