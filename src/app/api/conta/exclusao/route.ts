import { ok, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sendEmail, renderEmail } from "@/lib/email";
import { FORNECEDOR } from "@/lib/fornecedor";
import { env } from "@/lib/env";

/**
 * Solicitação de exclusão da conta (art. 18, VI, da LGPD).
 *
 * O pedido é REGISTRADO, não executado: conta com pagamento aprovado não pode ser
 * apagada sem antes separar o que a lei obriga a conservar (registro fiscal e
 * contábil) do que deve ser eliminado ou anonimizado. Quem conduz isso é o
 * Encarregado, pelo painel administrativo.
 *
 * ── Por que o pedido agora AVISA alguém ───────────────────────────────────────
 * Antes, a rota criava uma notificação para o PRÓPRIO SOLICITANTE e escrevia na
 * auditoria. Ninguém do outro lado era avisado: o pedido só apareceria se alguém
 * fosse ler a trilha de auditoria por conta própria. E a Política de Privacidade
 * promete prazo de resposta — prazo que ninguém cumpre se o pedido não chega a uma
 * pessoa. Pedido de titular perdido é descumprimento do art. 18, §3º, e dá ao
 * titular razão numa reclamação à ANPD.
 *
 * Então o pedido vai a três lugares: notificação para o titular (recibo),
 * notificação para cada administrador (fila de trabalho) e e-mail para o canal de
 * privacidade divulgado nos documentos legais.
 */
export const POST = route(async () => {
  const user = await requireUser();

  await prisma.notification.create({
    data: {
      userId: user.id,
      title: "Solicitação de exclusão recebida",
      body:
        "Seu pedido de exclusão de dados foi registrado e será processado conforme a política de retenção. " +
        "Você será informado(a) sobre o que foi eliminado, o que foi anonimizado e o que a lei obriga a conservar.",
    },
  });

  // Fila de trabalho de quem opera: um item por administrador.
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN", status: "ATIVO" },
    select: { id: true },
  });
  if (admins.length > 0) {
    await prisma.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        title: "Pedido de exclusão de dados (LGPD)",
        body: `${user.name} (${user.email}) solicitou a exclusão da conta. Verifique o inventário e a trava de pagamento aprovado antes de executar.`,
      })),
    });
  }

  /**
   * O e-mail é o que faz o pedido sair do sistema e chegar a uma caixa que alguém
   * abre. Falha no envio NÃO derruba o pedido: ele já está registrado no banco e na
   * auditoria, e responder erro faria o titular pedir de novo achando que não
   * valeu — quando valeu.
   */
  let avisoEnviado = true;
  try {
    await sendEmail({
      to: FORNECEDOR.emailPrivacidade,
      subject: `[LGPD] Pedido de exclusão de conta — ${user.email}`,
      html: renderEmail(
        "Pedido de exclusão de dados",
        `<p>${user.name} (${user.email}) solicitou a exclusão da conta.</p>` +
          `<p>Antes de executar, confira o inventário da conta e a trava de pagamento aprovado: conta com venda aprovada exige anonimização com bloqueio, não exclusão.</p>`,
        { label: "Abrir o painel", url: `${env.appUrl}/admin/usuarios` },
      ),
      text: `${user.name} (${user.email}) solicitou a exclusão da conta. Painel: ${env.appUrl}/admin/usuarios`,
    });
  } catch (err) {
    avisoEnviado = false;
    console.error("[conta/exclusao] pedido registrado, mas o aviso NÃO foi enviado:", (err as Error).message);
  }

  await logAudit({
    actorId: user.id,
    action: "account.deletion_requested",
    entityType: "User",
    entityId: user.id,
    metadata: { avisoEnviado, administradoresNotificados: admins.length },
  });

  return ok({ message: "Solicitação de exclusão registrada. Você será informado(a) sobre o andamento." });
});
