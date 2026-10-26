import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { supportStatusSchema } from "@/lib/validation";
import { mudarStatusChamado } from "@/lib/support";

export const runtime = "nodejs";

/**
 * Mudança de status do chamado — ação da equipe (ADMIN ou SUPORTE).
 *
 * Fica sob /api/admin para deixar explícito que é rota de operação, e a
 * checagem de papel é feita no SERVIDOR com requireRole: o middleware só
 * confere a presença do cookie e não serve como controle de acesso.
 *
 * Marcar RESOLVIDO/ENCERRADO grava resolvedAt e dispara o aviso ao cliente
 * (dentro de mudarStatusChamado).
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireRole("ADMIN", "SUPORTE");
  const { status } = supportStatusSchema.parse(await req.json());

  const r = await mudarStatusChamado((await ctx.params).id, { id: user.id, role: user.role }, status);
  if (!r) return fail("Chamado não encontrado.", 404);
  return ok(r);
});
