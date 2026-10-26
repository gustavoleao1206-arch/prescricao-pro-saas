import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { generateSecret, otpauthUrl, qrDataUrl, encryptSecret } from "@/lib/twofactor";

export const runtime = "nodejs";

/** Inicia a configuração de 2FA: gera segredo pendente e retorna QR + segredo. */
export const POST = route(async () => {
  const session = await requireUser();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.id } });
  if (user.twoFactorEnabled) return fail("2FA já está ativo. Desative antes de reconfigurar.", 409);

  const secret = generateSecret();
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorPendingSecret: encryptSecret(secret) } });

  const otpauth = otpauthUrl(user.email, secret);
  const qr = await qrDataUrl(otpauth);
  return ok({ secret, otpauthUrl: otpauth, qrDataUrl: qr });
});
