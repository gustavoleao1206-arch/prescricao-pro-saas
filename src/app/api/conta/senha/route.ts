import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { verifyPassword, hashPassword, validatePasswordStrength } from "@/lib/password";
import { logAudit } from "@/lib/audit";
import { cancelarTrocaDeEmailPendente } from "@/lib/troca-de-email";
import { z } from "zod";

export const runtime = "nodejs";

const schema = z.object({
  currentPassword: z.string().min(1, "Informe a senha atual."),
  newPassword: z.string().min(10, "A nova senha deve ter ao menos 10 caracteres."),
});

/** Alteração de senha pelo próprio usuário autenticado (exige a senha atual). */
export const POST = route(async (req: NextRequest) => {
  const sessionUser = await requireUser();
  const { currentPassword, newPassword } = schema.parse(await req.json());

  const user = await prisma.user.findUnique({ where: { id: sessionUser.id } });
  if (!user) return fail("Usuário não encontrado.", 404);

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return fail("Senha atual incorreta.", 400);
  }
  const strength = validatePasswordStrength(newPassword);
  if (strength.length) return fail(strength.join(" "), 422);

  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
  await logAudit({ actorId: user.id, action: "auth.password_changed", entityType: "User", entityId: user.id });

  /**
   * ⚠️ Trocar a senha CANCELA a troca de e-mail pendente. Sem isto, o aviso antifraude mentia.
   *
   * O aviso que vai ao endereço antigo quando alguém pede a troca diz "troque sua senha agora".
   * Enquanto esta linha não existia, obedecer não desarmava nada: o link do pedido seguia válido
   * pela hora inteira e a confirmação é rota pública, sem sessão e sem senha. O atacante que
   * sabia a senha pedia a troca, a vítima trocava a senha como instruído, e ele confirmava
   * depois — virava dono do e-mail da conta e a tomava pelo "esqueci minha senha".
   *
   * É a mesma ideia da revogação de sessões: credencial nova invalida o que a credencial velha
   * autorizou.
   */
  const cancelada = await cancelarTrocaDeEmailPendente(user.id, "senha alterada pelo titular");

  return ok({
    message: cancelada.cancelou
      ? "Senha alterada. O pedido de troca de e-mail que estava pendente foi cancelado."
      : "Senha alterada com sucesso.",
  });
});
