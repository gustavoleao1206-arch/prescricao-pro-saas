import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

/**
 * Ativa uma versão de prompt e desativa as demais do MESMO tipo.
 * Permite versionamento/auditoria das instruções da IA sem alterar código.
 */
export const POST = route(async (_req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const admin = await requireRole("ADMIN");
  const prompt = await prisma.promptVersion.findUnique({ where: { id: params.id } });
  if (!prompt) return fail("Versão de prompt não encontrada.", 404);

  await prisma.$transaction([
    prisma.promptVersion.updateMany({ where: { kind: prompt.kind }, data: { active: false } }),
    prisma.promptVersion.update({ where: { id: prompt.id }, data: { active: true } }),
  ]);

  await logAudit({
    actorId: admin.id,
    actorRole: "ADMIN",
    action: "admin.prompt.activate",
    entityType: "PromptVersion",
    entityId: prompt.id,
    metadata: { kind: prompt.kind, version: prompt.version },
  });
  return ok({ id: prompt.id, active: true });
});
