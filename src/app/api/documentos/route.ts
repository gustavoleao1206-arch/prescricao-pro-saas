import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireAppContext, getAnalysisForContext, assertActiveSubscription } from "@/lib/tenant";
import { agentRateAllowed } from "@/lib/rate-limit";
import { receberDocumento } from "@/lib/document-intake";
import { logAudit } from "@/lib/audit";
import { formDataComTeto } from "@/lib/corpo-da-requisicao";

export const runtime = "nodejs";

export const POST = route(async (req: NextRequest) => {
  const ctx = await requireAppContext();
  // Gate NO SERVIDOR: só assina ativo (ou equipe) sobe documentos; + uso justo.
  assertActiveSubscription(ctx);
  if (!agentRateAllowed(ctx.user.id, "upload"))
    return fail("Muitos envios em pouco tempo. Aguarde alguns segundos e tente novamente.", 429);
  /**
   * ⚠️ Teto ANTES de o corpo entrar na memória — ver `@/lib/corpo-da-requisicao`.
   *
   * Aqui estava o defeito: `req.formData()` lia o arquivo inteiro, e o limite de tamanho só era conferido
   * depois. O limite existia e nunca era alcançado.
   */
  const corpo = await formDataComTeto(req);
  if (!corpo.ok) return fail(corpo.erro, corpo.status);
  const formData = corpo.formData;
  const analysisId = String(formData.get("analysisId") ?? "");
  const file = formData.get("file");

  if (!analysisId) return fail("Análise não informada.", 400);
  if (!(file instanceof File)) return fail("Arquivo não enviado.", 400);

  const analysis = await getAnalysisForContext(analysisId, ctx);
  if (!analysis) return fail("Análise não encontrada.", 404);
  if (analysis.ownerId !== ctx.user.id && ctx.user.role !== "ADMIN") return fail("Sem permissão para esta análise.", 403);

  /**
   * ⚠️ Análise ENCERRADA não recebe documento — porque a linha abaixo a RESSUSCITARIA.
   *
   * O envio grava `status: "DOCUMENTOS_ENVIADOS"` sem olhar o status atual. Numa análise cancelada isso
   * desfazia o cancelamento em silêncio: ela voltava a ser processável, e a trava que impede reprocessar
   * análise cancelada (que existe para não recobrar o crédito devolvido) era contornada só subindo um
   * arquivo. Arquivar tinha o mesmo furo.
   *
   * A mensagem diz o caminho, porque quem sobe documento numa análise arquivada quase sempre quer
   * retomá-la, não abrir outra.
   */
  if (analysis.status === "CANCELADA" || analysis.status === "ARQUIVADA") {
    return fail(
      analysis.status === "CANCELADA"
        ? "Esta análise foi cancelada e não recebe novos documentos. Inicie uma análise nova, ou fale com o suporte para reabrir esta."
        : "Esta análise está arquivada. Desarquive-a antes de enviar documentos.",
      409,
      { reason: "analise_encerrada" },
    );
  }

  // Limites, formato, tamanho e deduplicação ficam no recebimento compartilhado.
  const r = await receberDocumento({ analysisId, organizationId: analysis.organizationId, file });
  if (!r.ok) return fail(r.erro, r.status);

  await prisma.analysis.update({ where: { id: analysisId }, data: { status: "DOCUMENTOS_ENVIADOS" } });
  await logAudit({ actorId: ctx.user.id, action: "document.upload", entityType: "Document", entityId: r.documento.id, metadata: { analysisId, sizeBytes: r.documento.sizeBytes } });

  return ok({ id: r.documento.id, filename: r.documento.filename, sizeBytes: r.documento.sizeBytes }, { status: 201 });
});
