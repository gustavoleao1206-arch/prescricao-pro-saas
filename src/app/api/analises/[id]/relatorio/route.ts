import { NextRequest } from "next/server";
import { fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireAppContext, getAnalysisForContext, assertActiveSubscription } from "@/lib/tenant";
import { agentRateAllowed } from "@/lib/rate-limit";
import { markdownToDocx, markdownToPdf } from "@/lib/export";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Download do relatório mais recente em md | pdf | docx. */
export const GET = route(async (req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const ctx = await requireAppContext();
  assertActiveSubscription(ctx);
  if (!agentRateAllowed(ctx.user.id, "report")) return fail("Muitas solicitações em pouco tempo. Aguarde e tente novamente.", 429);
  const analysis = await getAnalysisForContext(params.id, ctx);
  if (!analysis) return fail("Análise não encontrada.", 404);

  const report = await prisma.report.findFirst({ where: { analysisId: params.id }, orderBy: { version: "desc" } });
  if (!report) return fail("Relatório ainda não disponível.", 404);

  const format = (new URL(req.url).searchParams.get("format") ?? "pdf").toLowerCase();
  const base = `relatorio-${params.id}`;
  await logAudit({
    actorId: ctx.user.id,
    actorRole: ctx.user.role,
    action: "report.download",
    entityType: "Report",
    entityId: report.id,
    metadata: { format },
    // Origem do acesso: ver a justificativa em api/documentos/[id]/download.
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent") ?? undefined,
  });

  if (format === "md") {
    return file(report.markdown, "text/markdown", `${base}.md`);
  }
  if (format === "docx") {
    const buf = await markdownToDocx(analysis.title, report.markdown);
    return file(buf, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", `${base}.docx`);
  }
  const pdf = await markdownToPdf(analysis.title, report.markdown);
  return file(pdf, "application/pdf", `${base}.pdf`);
});

function file(data: string | Buffer, type: string, filename: string): Response {
  const body = typeof data === "string" ? data : new Uint8Array(data);
  return new Response(body, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
