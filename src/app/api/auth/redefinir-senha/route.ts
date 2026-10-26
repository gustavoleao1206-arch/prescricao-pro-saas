import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { resetSchema } from "@/lib/validation";
import { hashPassword, validatePasswordStrength } from "@/lib/password";
import { sha256 } from "@/lib/crypto";
import { revokeAllSessions } from "@/lib/auth";
import { rateLimit, clientIp, tempoDeEspera } from "@/lib/rate-limit";
import { logAudit, logSecurityEvent } from "@/lib/audit";
import { VERSAO_DOCUMENTOS } from "@/lib/fornecedor";
import { cancelarTrocaDeEmailPendente } from "@/lib/troca-de-email";

/**
 * Redefine a senha a partir de um token (RECUPERACAO_SENHA ou CRIACAO_SENHA).
 * Ao concluir, ativa a conta (se pendente) e revoga todas as sessões existentes.
 */
export const POST = route(async (req: NextRequest) => {
  const ip = clientIp(req);
  const limite = rateLimit(`reset:${ip}`, 10, 600);
  if (!limite.allowed) return fail(`Muitas tentativas. Aguarde ${tempoDeEspera(limite.resetAt)}.`, 429);

  const { token, password, acceptTerms } = resetSchema.parse(await req.json());
  const strength = validatePasswordStrength(password);
  if (strength.length) return fail(strength.join(" "), 422);

  const record = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (
    !record ||
    record.usedAt ||
    record.expiresAt < new Date() ||
    (record.type !== "RECUPERACAO_SENHA" && record.type !== "CRIACAO_SENHA")
  ) {
    await logSecurityEvent({ type: "reset_invalid_token", ip });
    return fail("Link inválido ou expirado. Solicite um novo.", 400);
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: {
        passwordHash: await hashPassword(password),
        /**
         * ⚠️ O status só sobe de PENDENTE_VERIFICACAO para ATIVO. Nunca desfaz bloqueio.
         *
         * Gravava `status: "ATIVO"` sem olhar o atual, e o caminho até aqui é PÚBLICO: pedir
         * "esqueci minha senha" manda o link para o e-mail da conta, e definir a senha nova
         * reativava uma conta BLOQUEADA ou SUSPENSA. Ou seja, o bloqueio administrativo se desfazia
         * sozinho no primeiro reset de senha — e quem foi bloqueado é exatamente quem tem motivo
         * para tentar isso.
         *
         * As contas provisionadas pela venda (token CRIACAO_SENHA) já nascem ATIVO na liberação
         * manual, então elas não dependiam desta linha para entrar. Mesmo conserto já aplicado na
         * confirmação de e-mail e na confirmação de troca de e-mail: o defeito estava nos três.
         */
        ...(record.user.status === "PENDENTE_VERIFICACAO" ? { status: "ATIVO" as const } : {}),
        emailVerifiedAt: record.user.emailVerifiedAt ?? new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }),
    prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);

  // Contas provisionadas pela compra (CRIACAO_SENHA): registra o aceite de termos/
  // condições da assinatura ao definir a senha, se ainda não houver.
  if (record.type === "CRIACAO_SENHA" && acceptTerms) {
    const jaTem = await prisma.consent.findFirst({ where: { userId: record.userId, type: "CONDICOES_ASSINATURA" } });
    if (!jaTem) {
      // Versão REAL do documento aceito, não "1.0" fixo: registro que aponta para a
      // versão errada não prova o que a pessoa aceitou (art. 8º, §1º, da LGPD).
      await prisma.consent.createMany({
        data: [
          { userId: record.userId, type: "TERMOS_USO", version: VERSAO_DOCUMENTOS, ip },
          { userId: record.userId, type: "POLITICA_PRIVACIDADE", version: VERSAO_DOCUMENTOS, ip },
          { userId: record.userId, type: "CONDICOES_ASSINATURA", version: VERSAO_DOCUMENTOS, ip },
        ],
      });
    }
  }

  // Revoga sessões antigas por segurança.
  await revokeAllSessions(record.userId);

  /**
   * ⚠️ E cancela a troca de e-mail pendente, pelo mesmo motivo da revogação de sessões.
   *
   * Este é o caminho que a vítima de fato usa: o aviso de "alguém pediu para trocar seu e-mail"
   * manda trocar a senha, e quem está assustado clica em "esqueci minha senha". Revogar sessões
   * não bastava — a confirmação da troca é rota PÚBLICA, sem sessão e sem senha, então o link do
   * atacante sobrevivia à revogação e continuava valendo pela hora inteira. Ele confirmava
   * depois, virava dono do endereço da conta e a tomava pedindo recuperação de senha para o
   * endereço novo.
   *
   * Credencial nova invalida o que a credencial velha autorizou. Vale para sessão e vale para
   * pedido de troca de endereço.
   */
  await cancelarTrocaDeEmailPendente(record.userId, "senha redefinida pelo titular");

  await logAudit({ actorId: record.userId, action: "auth.password_reset", ip });

  /**
   * Conta bloqueada ou suspensa tem a senha trocada e SEGUE bloqueada — ver a trava de status
   * acima. Prometer "você já pode entrar" ali manda a pessoa bater numa porta fechada sem saber por
   * quê, e o suporte recebe a reclamação errada.
   */
  const acessoSuspenso = record.user.status === "BLOQUEADO" || record.user.status === "SUSPENSO";
  return ok({
    /**
     * ⚠️ Este campo existe porque a tela DESCARTAVA a mensagem.
     *
     * `ResetForm` redireciona para `/login?definida=1` em qualquer sucesso e joga o texto fora — então
     * a frase acima, sozinha, era código morto: quem tem a conta bloqueada definia a senha, era
     * mandado para o login e só ali batia numa recusa genérica, sem ligação com o que acabara de
     * fazer. O sinalizador permite a tela PARAR no lugar do redirecionamento e mostrar o motivo.
     */
    acessoSuspenso,
    message: acessoSuspenso
      ? "Senha definida com sucesso. Mas o acesso desta conta está suspenso, então entrar não vai" +
        " funcionar — fale com o suporte para reativá-la."
      : "Senha definida com sucesso. Você já pode entrar.",
  });
});
