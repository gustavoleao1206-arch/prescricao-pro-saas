import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireAppContext, getAnalysisForContext } from "@/lib/tenant";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

/**
 * Conclusão da revisão jurídica pelo advogado responsável.
 *
 * A análise nasce em AGUARDANDO_REVISAO com um LegalReview PENDENTE — e, até
 * aqui, nada no sistema mudava esse estado: a revisão ficava pendente para
 * sempre e a análise nunca chegava a CONCLUIDA.
 *
 * Quem revisa é o próprio assinante, que é advogado(a): toda saída do sistema
 * é apoio e exige conferência profissional. O registro de quem revisou, quando
 * e com quais ressalvas é o que transforma esse dever em prova de diligência.
 */

const schema = z.object({
  decisao: z.enum(["APROVADA", "DEVOLVIDA"]),
  notes: z.string().max(5000).optional(),
  risks: z.string().max(5000).optional(),
  divergences: z.string().max(5000).optional(),
});

export const POST = route(async (req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const ctx = await requireAppContext();
  const analysis = await getAnalysisForContext(params.id, ctx);
  if (!analysis) return fail("Análise não encontrada.", 404);

  // Revisar é ato do dono da análise; ADMIN e REVISOR revisam em apoio.
  const podeRevisar =
    analysis.ownerId === ctx.user.id || ctx.user.role === "ADMIN" || ctx.user.role === "REVISOR";
  if (!podeRevisar) return fail("Sem permissão para revisar esta análise.", 403);

  const emAndamento = ["VALIDANDO_DOCUMENTOS", "EXTRAINDO_INFORMACOES", "PROCESSANDO"];
  if (emAndamento.includes(analysis.status)) {
    return fail("A análise ainda está em processamento.", 409);
  }

  const { decisao, notes, risks, divergences } = schema.parse(await req.json());

  await prisma.legalReview.upsert({
    where: { analysisId: analysis.id },
    create: {
      analysisId: analysis.id,
      reviewerId: ctx.user.id,
      status: decisao,
      notes,
      risks,
      divergences,
      decidedAt: new Date(),
    },
    update: {
      reviewerId: ctx.user.id,
      status: decisao,
      notes,
      risks,
      divergences,
      decidedAt: new Date(),
    },
  });

  // Aprovada encerra a análise; devolvida volta a aguardar, para reprocessar
  // ou complementar os documentos.
  await prisma.analysis.update({
    where: { id: analysis.id },
    data: {
      status: decisao === "APROVADA" ? "CONCLUIDA" : "AGUARDANDO_INFORMACOES",
      ...(decisao === "APROVADA" ? { completedAt: new Date() } : {}),
    },
  });

  await logAudit({
    actorId: ctx.user.id,
    actorRole: ctx.user.role,
    action: "analysis.review",
    entityType: "Analysis",
    entityId: analysis.id,
    metadata: { decisao, comRessalvas: Boolean(risks || divergences) },
  });

  return ok({
    status: decisao,
    analysisStatus: decisao === "APROVADA" ? "CONCLUIDA" : "AGUARDANDO_INFORMACOES",
  });
});
