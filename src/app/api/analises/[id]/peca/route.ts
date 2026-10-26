import { NextRequest } from "next/server";
import { fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireAppContext, getAnalysisForContext, assertActiveSubscription } from "@/lib/tenant";
import { agentRateAllowed } from "@/lib/rate-limit";
import { markdownToDocx, markdownToPdf } from "@/lib/export";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Download da minuta (peça) em md | pdf | docx. Aceita ?petitionId=... */
export const GET = route(async (req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const ctx = await requireAppContext();
  assertActiveSubscription(ctx);
  if (!agentRateAllowed(ctx.user.id, "petition")) return fail("Muitas solicitações em pouco tempo. Aguarde e tente novamente.", 429);
  const analysis = await getAnalysisForContext(params.id, ctx);
  if (!analysis) return fail("Análise não encontrada.", 404);

  const url = new URL(req.url);
  const petitionId = url.searchParams.get("petitionId");
  const petition = petitionId
    ? await prisma.petition.findFirst({ where: { id: petitionId, analysisId: params.id } })
    : await prisma.petition.findFirst({ where: { analysisId: params.id }, orderBy: { createdAt: "desc" } });
  if (!petition) return fail("Minuta ainda não disponível.", 404);

  const format = (url.searchParams.get("format") ?? "docx").toLowerCase();
  const base = `minuta-${petition.id}`;
  await logAudit({
    actorId: ctx.user.id,
    actorRole: ctx.user.role,
    action: "petition.download",
    entityType: "Petition",
    entityId: petition.id,
    metadata: { format },
    // Origem do acesso: ver a justificativa em api/documentos/[id]/download.
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent") ?? undefined,
  });

  if (format === "md") return file(petition.markdown, "text/markdown", `${base}.md`);
  if (format === "pdf") {
    const pdf = await markdownToPdf(petition.title, petition.markdown);
    return file(pdf, "application/pdf", `${base}.pdf`);
  }
  const docx = await markdownToDocx(petition.title, petition.markdown);
  return file(docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", `${base}.docx`);
});

function file(data: string | Buffer, type: string, filename: string): Response {
  const body = typeof data === "string" ? data : new Uint8Array(data);
  return new Response(body, {
    headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" },
  });
}
