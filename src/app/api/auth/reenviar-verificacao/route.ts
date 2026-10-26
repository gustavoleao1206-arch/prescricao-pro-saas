import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { rateLimit, clientIp, tempoDeEspera } from "@/lib/rate-limit";
import { emitirVerificacaoDeEmail } from "@/lib/verificacao-email";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Reenvio do e-mail de confirmação de cadastro.
 *
 * ── O que faltava ─────────────────────────────────────────────────────────────
 * Não havia como pedir outro e-mail. Se o primeiro se perdia — caixa de spam, endereço com um
 * dígito errado depois corrigido pelo painel, entrega recusada pelo servidor de destino —, a
 * pessoa ficava com a conta pendente e nenhum caminho dentro do produto. O único jeito era
 * usar "esqueci minha senha", que verifica o e-mail como efeito colateral: funciona por
 * acidente, e ninguém adivinha isso.
 *
 * ── Por que é AUTENTICADA, e por que isso é melhor ────────────────────────────
 * A escolha óbvia seria uma rota pública recebendo o e-mail, como a de recuperação de senha.
 * Aqui ela é pior, e dá para ser melhor por um fato do sistema: conta pendente de verificação
 * NÃO é impedida de entrar (`PENDENTE_VERIFICACAO` não barra o login). Então quem precisa do
 * reenvio consegue pedir de dentro.
 *
 * O ganho é grande. Rota pública que recebe e-mail é, ao mesmo tempo, uma forma de descobrir
 * quem tem conta (mesmo respondendo igual para os dois casos, o tempo de resposta difere) e um
 * jeito de mandar e-mail nosso, repetidamente, para o endereço de qualquer pessoa — uma arma
 * apontada para a nossa reputação de remetente, que é o que faz o e-mail de ativação e o de
 * cobrança chegarem na caixa de entrada. Exigindo sessão, os dois problemas desaparecem: só se
 * pede reenvio para o próprio endereço.
 *
 * Quem não consegue entrar de jeito nenhum continua com "esqueci minha senha", que também
 * ativa a conta — e agora isso é caminho declarado, não acidente.
 */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();

  /**
   * ⚠️ O limite é por CONTA, não por IP.
   *
   * Por IP, quem estivesse atrás do mesmo escritório dividiria a cota e um bloquearia o outro.
   * E o abuso que importa aqui não é de rede: é a mesma pessoa clicando dez vezes por não ver o
   * e-mail chegar — cada clique é um envio, e envio repetido para o mesmo endereço é o que
   * derruba a reputação do remetente e joga tudo na caixa de spam, inclusive o e-mail seguinte.
   *
   * Três em quinze minutos: suficiente para duas tentativas honestas com folga, insuficiente
   * para bombardear.
   */
  const limite = rateLimit(`reenviar-verificacao:${user.id}`, 3, 900);
  if (!limite.allowed) {
    /**
     * A recusa diz o PRAZO, e o prazo vem do próprio balde.
     *
     * "Aguarde alguns minutos" fazia a pessoa voltar em dois, ser recusada, voltar em cinco, ser
     * recusada — e desistir. A janela aqui é de 15 minutos, número que a tela nunca dizia embora
     * `rateLimit` sempre devolvesse `resetAt`.
     */
    return fail(
      `Você já pediu o reenvio três vezes. Aguarde ${tempoDeEspera(limite.resetAt)} antes de tentar de` +
        " novo — e confira a caixa de spam, que é onde o e-mail costuma estar.",
      429,
    );
  }

  /**
   * Já verificado responde com franqueza em vez de mandar e-mail.
   *
   * Não há risco de revelar nada — é a própria conta de quem pediu. E reenviar aqui seria pior
   * que inútil: a pessoa receberia um link de confirmação para uma conta já confirmada e
   * concluiria que a verificação anterior não valeu.
   */
  const atual = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { id: true, email: true, name: true, emailVerifiedAt: true, status: true },
  });
  if (atual.emailVerifiedAt) {
    return ok({ enviado: false, jaVerificado: true, message: "Seu e-mail já está confirmado. Não é preciso reenviar." });
  }

  const emissao = await emitirVerificacaoDeEmail(atual);

  await logAudit({
    actorId: user.id,
    action: "auth.verification_resent",
    entityType: "User",
    entityId: user.id,
    ip: clientIp(req),
    metadata: { enviado: emissao.enviado },
  });

  /**
   * Falha de envio não é 500. O link foi criado e os anteriores foram invalidados — o estado
   * mudou —, e responder erro faria a pessoa clicar de novo, gastando a cota do limite acima
   * sem entender por quê. O que ela precisa saber é que o e-mail não saiu e o que fazer então.
   */
  if (!emissao.enviado) {
    return ok({
      enviado: false,
      substituiuAnteriores: emissao.substituiuAnteriores,
      message:
        "Não conseguimos enviar o e-mail agora. Tente novamente em alguns minutos — se continuar," +
        " fale com o suporte, que confirmamos sua conta manualmente." +
        /**
         * O pior estado possível, e ele precisa ser dito: o link anterior JÁ foi invalidado (a
         * invalidação acontece antes do envio) e o novo não saiu. A pessoa está sem link nenhum. Se
         * a tela não avisar, ela vai procurar o e-mail antigo, clicar, receber recusa e concluir
         * que a conta quebrou.
         */
        (emissao.substituiuAnteriores
          ? " O link anterior já não vale mais, então não use o e-mail antigo: espere o novo."
          : ""),
    });
  }

  /**
   * ⚠️ A mensagem AVISA que o link anterior morreu — e só quando ele existia.
   *
   * O reenvio invalida os links anteriores de propósito (o caso que importa é o endereço digitado
   * errado: o link antigo foi para a caixa de um terceiro e não pode continuar valendo). Só que
   * nada dizia isso a quem clicou. A pessoa passava a ter dois e-mails iguais na caixa, abria o
   * antigo — que é o que ela lembra de ter recebido, e que a busca por "Prescrição" acha primeiro —
   * e lia "link inválido". A leitura natural é "o reenvio não funcionou", e a reação é clicar de
   * novo, gastando a cota de três.
   */
  return ok({
    enviado: true,
    substituiuAnteriores: emissao.substituiuAnteriores,
    message:
      `Enviamos um novo link de confirmação para ${atual.email}. Confira também a caixa de spam.` +
      (emissao.substituiuAnteriores
        ? " Atenção: o link que enviamos antes deixou de valer — use o e-mail mais recente."
        : ""),
  });
});
