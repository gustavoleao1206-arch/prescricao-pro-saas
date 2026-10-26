import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { verifyTotp, decryptSecret, generateBackupCodes } from "@/lib/twofactor";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

export const runtime = "nodejs";

/** Confirma a ativação do 2FA verificando um código e gera os códigos de backup. */
export const POST = route(async (req: NextRequest) => {
  const session = await requireUser();
  const { token } = z.object({ token: z.string().min(6).max(12) }).parse(await req.json());

  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.id } });
  const pending = decryptSecret(user.twoFactorPendingSecret);
  if (!pending) return fail("Inicie a configuração de 2FA primeiro.", 400);
  if (!verifyTotp(pending, token)) return fail("Código inválido. Verifique o app autenticador.", 401);

  const { plain, hashed } = generateBackupCodes();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      twoFactorEnabled: true,
      twoFactorSecret: user.twoFactorPendingSecret, // já criptografado
      twoFactorPendingSecret: null,
      twoFactorBackupCodes: hashed,
    },
  });
  await logAudit({ actorId: user.id, actorRole: user.role, action: "auth.2fa.enabled" });

  // Os códigos de backup são retornados UMA ÚNICA VEZ.
  return ok({ enabled: true, backupCodes: plain });
});
