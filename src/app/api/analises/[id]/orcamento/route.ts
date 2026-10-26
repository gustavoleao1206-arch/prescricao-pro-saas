import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { requireAppContext, getAnalysisForContext } from "@/lib/tenant";
import { orcamentoDaAnalise, orcamentoParaJson } from "@/lib/orcamento";

export const runtime = "nodejs";

/**
 * Quanto esta análise vai custar em créditos, e com que saldo o cliente fica.
 *
 * Consulta pura: não cobra nada e não dispara processamento. É o que alimenta a
 * tela de confirmação exigida antes de gastar crédito.
 */
export const GET = route(async (_req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const ctx = await requireAppContext();
  const analysis = await getAnalysisForContext(params.id, ctx);
  if (!analysis) return fail("Análise não encontrada.", 404);
  if (analysis.ownerId !== ctx.user.id && ctx.user.role !== "ADMIN") return fail("Sem permissão.", 403);

  const orcamento = await orcamentoDaAnalise(analysis.id, ctx.subscription);
  return ok(orcamentoParaJson(orcamento));
});
