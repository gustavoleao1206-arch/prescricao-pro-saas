import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { forgotSchema } from "@/lib/validation";
import { randomToken, sha256 } from "@/lib/crypto";
import { rateLimit, clientIp, tempoDeEspera } from "@/lib/rate-limit";
import { sendEmail, renderEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import { env } from "@/lib/env";

export const POST = route(async (req: NextRequest) => {
  const ip = clientIp(req);
  const limite = rateLimit(`forgot:${ip}`, 5, 600);
  if (!limite.allowed) return fail(`Muitas solicitações. Aguarde ${tempoDeEspera(limite.resetAt)}.`, 429);

  const { email } = forgotSchema.parse(await req.json());
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  // Sempre responde OK para não revelar se o e-mail existe.
  if (user) {
    const token = randomToken(32);
    await prisma.authToken.create({
      data: { userId: user.id, type: "RECUPERACAO_SENHA", tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60 * 60_000) },
    });
    const url = `${env.appUrl}/redefinir-senha?token=${token}`;
    await sendEmail({
      to: user.email,
      subject: "Redefinição de senha — Prescrição Pro",
      html: renderEmail("Redefinir senha", `<p>Recebemos uma solicitação para redefinir sua senha. O link expira em 1 hora.</p>`, {
        label: "Redefinir senha",
        url,
      }),
      text: `Redefina sua senha: ${url}`,
    });
    await logAudit({ actorId: user.id, action: "auth.forgot_password", ip });
  }

  return ok({ message: "Se o e-mail existir, enviaremos instruções de redefinição." });
});
