import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { loginSchema } from "@/lib/validation";
import { verifyPassword } from "@/lib/password";
import { createSession } from "@/lib/auth";
import { rateLimit, clientIp, tempoDeEspera } from "@/lib/rate-limit";
import { logAudit, logSecurityEvent } from "@/lib/audit";
import { verifyTotp, matchBackupCode, decryptSecret } from "@/lib/twofactor";
import { getCurrentSubscription, subscriptionGrantsAccess } from "@/lib/consumption";
import { env } from "@/lib/env";

const ACESSO_INDISPONIVEL = "Seu acesso está temporariamente indisponível. Entre em contato com o suporte para regularização.";

export const POST = route(async (req: NextRequest) => {
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") ?? undefined;
  const data = loginSchema.parse(await req.json());
  const email = data.email.toLowerCase();

  /**
   * Rate limit por IP e por e-mail (proteção contra força bruta).
   *
   * ⚠️ A ordem e o curto-circuito são preservados: se o balde do IP já estourou, o do e-mail NÃO é
   * incrementado. Avaliar os dois sempre mudaria o comportamento do limite — a cota por e-mail
   * seria consumida por tentativas que nem chegaram a ser processadas.
   *
   * A recusa passou a dizer o prazo (5 minutos aqui). Isso não revela nada sobre a existência da
   * conta: o balde por e-mail é criado a partir do endereço DIGITADO, exista ou não a conta.
   */
  const porIp = rateLimit(`login:${ip}`, 20, 300);
  const porEmail = porIp.allowed ? rateLimit(`login:${email}`, 10, 300) : null;
  if (!porIp.allowed || !porEmail?.allowed) {
    await logSecurityEvent({ type: "rate_limited", email, ip, userAgent: ua });
    const espera = tempoDeEspera(porIp.allowed && porEmail ? porEmail.resetAt : porIp.resetAt);
    return fail(`Muitas tentativas. Aguarde ${espera} antes de tentar de novo.`, 429);
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Resposta genérica para não revelar existência de conta.
  const invalid = () => fail("Login ou senha inválidos.", 401);

  if (!user || !user.passwordHash) {
    await logSecurityEvent({ type: "login_failed", email, ip, userAgent: ua });
    return invalid();
  }

  // Conta bloqueada temporariamente?
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await logSecurityEvent({ type: "account_locked", email, ip, userAgent: ua });
    return fail("Conta temporariamente bloqueada por tentativas excessivas. Tente mais tarde.", 423);
  }

  if (user.status === "BLOQUEADO" || user.status === "SUSPENSO") {
    return fail(ACESSO_INDISPONIVEL, 403);
  }

  const valid = await verifyPassword(data.password, user.passwordHash);
  if (!valid) {
    const attempts = user.failedLoginCount + 1;
    const shouldLock = attempts >= env.security.loginMaxAttempts;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock ? new Date(Date.now() + env.security.loginLockMinutes * 60_000) : null,
      },
    });
    await logSecurityEvent({ type: "login_failed", email, ip, userAgent: ua, metadata: { attempts } });
    return invalid();
  }

  // 2FA (opcional) — verificação TOTP ou código de backup (uso único).
  if (user.twoFactorEnabled) {
    if (!data.totp) return fail("Informe o código de verificação (2FA).", 401, { require2fa: true });
    const secret = decryptSecret(user.twoFactorSecret);
    let twoOk = secret ? verifyTotp(secret, data.totp) : false;
    if (!twoOk) {
      const m = matchBackupCode(user.twoFactorBackupCodes, data.totp);
      if (m.ok) {
        twoOk = true;
        await prisma.user.update({ where: { id: user.id }, data: { twoFactorBackupCodes: m.remaining } });
      }
    }
    if (!twoOk) {
      await logSecurityEvent({ type: "login_2fa_failed", email, ip, userAgent: ua });
      return fail("Código de verificação inválido.", 401, { require2fa: true });
    }
  }

  // Verifica a assinatura NO SERVIDOR — somente o CLIENTE depende de assinatura.
  // Bloqueia o login apenas em estados que exigem intervenção (SUSPENSA/ESTORNADA).
  // Inadimplente/vencida/cancelada/sem assinatura ENTRAM, mas são levados à área de
  // assinatura para regularizar/assinar (o agente segue bloqueado pelo gate no servidor).
  let clienteDestino = "/painel";
  if (user.role === "CLIENTE") {
    const orgId =
      user.organizationId ??
      (await prisma.organization.findFirst({ where: { ownerId: user.id }, select: { id: true } }))?.id ??
      null;
    const sub = orgId ? await getCurrentSubscription(orgId) : null;
    if (sub && (sub.status === "SUSPENSA" || sub.status === "ESTORNADA")) {
      await logSecurityEvent({ type: "login_blocked_subscription", email, ip, userAgent: ua, metadata: { status: sub.status } });
      return fail(ACESSO_INDISPONIVEL, 403, { reason: "assinatura_bloqueada" });
    }
    if (!subscriptionGrantsAccess(sub)) clienteDestino = "/assinatura";
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  await createSession(user.id, { ip, userAgent: ua });
  await logAudit({ actorId: user.id, actorRole: user.role, action: "auth.login", ip, userAgent: ua });

  const redirect = user.role === "ADMIN" ? "/admin" : user.role === "REVISOR" ? "/painel" : clienteDestino;
  return ok({ role: user.role, redirect, needsVerification: user.status === "PENDENTE_VERIFICACAO" });
});
