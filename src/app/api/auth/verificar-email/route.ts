import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

/**
 * Confirmação do e-mail de cadastro, a partir do link enviado ao endereço.
 *
 * ── As recusas foram separadas, e a razão é comercial ─────────────────────────
 * Uma frase só — "link inválido ou expirado" — cobria quatro situações que pedem quatro ações
 * diferentes. A pior delas: quem já havia confirmado e voltava ao link (recarregando a aba,
 * clicando de novo no e-mail, ou com cliente de e-mail que pré-abre links para gerar a
 * pré-visualização) lia "inválido" e concluía que a conta não estava confirmada. E confirmar o
 * e-mail é pré-requisito para contratar: a pessoa parava de tentar comprar por causa de uma
 * mensagem de erro sobre algo que tinha dado certo.
 */
export const POST = route(async (req: NextRequest) => {
  const { token } = z.object({ token: z.string().min(10) }).parse(await req.json());
  const record = await prisma.authToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { status: true, emailVerifiedAt: true } } },
  });

  if (!record || record.type !== "VERIFICACAO_EMAIL") {
    return fail("Link de verificação inválido.", 400);
  }

  if (record.usedAt) {
    /**
     * ⚠️ Já confirmado responde 200: o resultado que a pessoa queria já é verdade.
     *
     * Aqui a leitura é do estado da CONTA, não do token — e isso torna a resposta exata sem
     * arqueologia nenhuma. Se o endereço está confirmado, dizer "seu e-mail já está confirmado" é
     * verdade mesmo que tenha sido outro link (um reenvio) que o confirmou; é justamente isso que a
     * pessoa precisa saber para parar de tentar.
     *
     * Não repito o endereço na mensagem de propósito. A conta pode ter trocado de e-mail depois, e
     * quem guardou este link é quem tinha acesso à caixa ANTIGA — dizer o endereço atual entregaria
     * a ela o endereço novo.
     */
    if (record.user.emailVerifiedAt) {
      /**
       * ⚠️ "Você já pode entrar" só sai se a conta de fato deixar entrar.
       *
       * A primeira versão prometia isso a qualquer conta com o e-mail confirmado — inclusive
       * BLOQUEADA e SUSPENSA —, contradizendo a trava de status que este mesmo arquivo aplica
       * cinquenta linhas abaixo. A pessoa ia para o login e batia numa recusa genérica.
       */
      return ok({
        jaConfirmado: true,
        message:
          record.user.status === "BLOQUEADO" || record.user.status === "SUSPENSO"
            ? "Seu e-mail já está confirmado. Mas o acesso desta conta está suspenso — fale com o suporte."
            : "Seu e-mail já está confirmado. Você já pode entrar.",
      });
    }
    /**
     * Usado, mas a conta não está confirmada: só um caminho leva a isto — um reenvio invalidou este
     * link para criar outro. É o caso em que a pessoa tem dois e-mails na caixa e abriu o antigo.
     */
    return fail(
      "Este link foi substituído por um mais novo. Abra o e-mail de confirmação mais recente — só o" +
        " último link vale.",
      400,
    );
  }

  if (record.expiresAt < new Date()) {
    return fail(
      "Este link de confirmação expirou; ele vale 2 dias. Entre na sua conta e use o botão" +
        " \"Reenviar o e-mail de confirmação\", no aviso do topo da tela.",
      400,
    );
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: {
        emailVerifiedAt: new Date(),
        /**
         * ⚠️ O status só sobe de PENDENTE_VERIFICACAO para ATIVO. Nunca desfaz bloqueio.
         *
         * Gravava `status: "ATIVO"` sem olhar o atual, e esta é uma rota PÚBLICA — sem sessão e sem
         * senha. Quem tivesse um link de confirmação ainda vivo de uma conta que o administrador
         * bloqueou ou suspendeu no meio do caminho a reativava clicando no e-mail. Bloqueio
         * administrativo desfeito por clique, e por caminho que nem pede para provar quem é.
         *
         * O único status que esta confirmação tem autoridade para mudar é o que ela de fato resolve:
         * a pendência de verificação. É o mesmo conserto já feito na confirmação da TROCA de e-mail
         * (`src/lib/troca-de-email.ts`) — o defeito estava nos dois lugares.
         */
        ...(record.user.status === "PENDENTE_VERIFICACAO" ? { status: "ATIVO" as const } : {}),
      },
    }),
    prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);
  await logAudit({ actorId: record.userId, action: "auth.email_verified" });

  /**
   * A mensagem acompanha o que de fato aconteceu. Com a trava acima, uma conta bloqueada tem o
   * e-mail confirmado e SEGUE bloqueada — anunciar "sua conta está ativa" ali seria mentira, e
   * mentira que manda a pessoa tentar entrar e falhar sem entender.
   */
  return ok({
    message:
      record.user.status === "PENDENTE_VERIFICACAO"
        ? "E-mail verificado. Sua conta está ativa."
        : "E-mail verificado.",
  });
});
