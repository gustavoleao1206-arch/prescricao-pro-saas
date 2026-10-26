import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { supportReplySchema } from "@/lib/validation";
import { carregarChamado, responderChamado } from "@/lib/support";

export const runtime = "nodejs";

/**
 * Um chamado específico: ler a conversa e responder.
 *
 * Serve os DOIS lados — equipe e cliente. Quem pode ver/responder é decidido
 * dentro de `carregarChamado`/`responderChamado` (cliente só o próprio
 * chamado), não aqui, para a regra valer em qualquer ponto de entrada.
 */

/** Conversa completa do chamado. */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const ticket = await carregarChamado((await ctx.params).id, user);
  // 404 também quando existe mas não é do cliente: não revela a existência de
  // chamado de outra pessoa.
  if (!ticket) return fail("Chamado não encontrado.", 404);
  return ok({ ticket });
});

/** Nova resposta no chamado. */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { message } = supportReplySchema.parse(await req.json());

  const r = await responderChamado((await ctx.params).id, { id: user.id, role: user.role, name: user.name }, message.trim());
  if (!r) return fail("Chamado não encontrado.", 404);
  return ok(r, { status: 201 });
});
