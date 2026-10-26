import { NextRequest } from "next/server";
import { fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireAppContext, getAnalysisForContext, assertActiveSubscription } from "@/lib/tenant";
import { getObject } from "@/lib/storage";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Download autenticado de documento privado. Valida o dono/organização e
 * registra o acesso. Não há URL pública direta — o arquivo é servido por aqui.
 * (Para recuperar dados sem assinatura ativa, use a exportação LGPD em /api/conta/exportar.)
 */
export const GET = route(async (req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const ctx = await requireAppContext();
  assertActiveSubscription(ctx);
  const doc = await prisma.document.findUnique({ where: { id: params.id } });
  if (!doc || doc.deletedAt) return fail("Documento não encontrado.", 404);

  // Confere acesso via a análise vinculada.
  if (doc.analysisId) {
    const analysis = await getAnalysisForContext(doc.analysisId, ctx);
    if (!analysis) return fail("Sem permissão.", 403);
  } else if (doc.organizationId !== ctx.organization?.id && ctx.user.role !== "ADMIN") {
    return fail("Sem permissão.", 403);
  }

  const buffer = await getObject(doc.storageKey);
  /**
   * IP e navegador entram no registro de propósito.
   *
   * O extrato de acessos é o único controle que a Política de Privacidade oferece em
   * troca do acesso técnico que ADMIN e REVISOR têm a documento sob sigilo
   * profissional — e ele registrava apenas quem e quando. Sem origem, o registro não
   * distingue o acesso do próprio titular do acesso feito de outro lugar, que é
   * exatamente a pergunta que se faz quando há suspeita de vazamento.
   */
  await logAudit({
    actorId: ctx.user.id,
    actorRole: ctx.user.role,
    action: "document.download",
    entityType: "Document",
    entityId: doc.id,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent") ?? undefined,
  });

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": doc.mimeType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(doc.filename)}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
