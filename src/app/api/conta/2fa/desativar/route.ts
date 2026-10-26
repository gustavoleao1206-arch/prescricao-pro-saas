import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { verifyTotp, decryptSecret, matchBackupCode } from "@/lib/twofactor";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

export const runtime = "nodejs";

/** Desativa o 2FA — exige um código válido (TOTP ou de backup). */
export const POST = route(async (req: NextRequest) => {
  const session = await requireUser();
  const { token } = z.object({ token: z.string().min(6).max(12) }).parse(await req.json());

  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.id } });
  if (!user.twoFactorEnabled) return ok({ disabled: true });

  const secret = decryptSecret(user.twoFactorSecret);
  const totpOk = secret ? verifyTotp(secret, token) : false;
  const backupOk = matchBackupCode(user.twoFactorBackupCodes, token).ok;
  if (!totpOk && !backupOk) return fail("Código inválido. Não foi possível desativar o 2FA.", 401);

  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorPendingSecret: null, twoFactorBackupCodes: [] },
  });
  await logAudit({ actorId: user.id, actorRole: user.role, action: "auth.2fa.disabled" });
  return ok({ disabled: true });
});
