import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireAppContext } from "@/lib/tenant";
import { sendCanceled } from "@/lib/subscription-emails";
import { logAudit } from "@/lib/audit";
import {
  asaasConfigured,
  cancelarRecorrencia,
  ehRecorrencia,
  MOTIVO_CANCELAMENTO_CLIENTE,
  paradaDeCobrancaSemEncerrar,
  pedidoDeParada,
} from "@/lib/asaas";

export const runtime = "nodejs";

/**
 * Cancelamento pelo cliente.
 *
 * Política: encerra a renovação, mas MANTÉM o acesso até o fim do período já pago
 * (`currentPeriodEnd`) — o mês foi comprado e é entregue.
 *
 * ⚠️ O ponto que fazia isto ser cobrança indevida: a rota só marcava CANCELADA no
 * nosso banco. Nada era dito ao gateway, e a recorrência seguia debitando o cartão
 * todo mês. Enquanto a Hotmart existia, o texto empurrava a responsabilidade para
 * o cliente ("confirme na área do assinante"); com o Asaas não há área do
 * assinante, então quem tem de interromper a cobrança somos nós.
 *
 * Ordem: grava o cancelamento PRIMEIRO, tenta o gateway depois. Se o Asaas
 * estiver fora do ar, o pedido do cliente não pode ser perdido nem recusado — o
 * direito de cancelar não depende da disponibilidade do provedor. Quando a
 * interrupção não é confirmada, a resposta diz isso com honestidade e fica
 * registrado um evento de segurança para alguém cancelar à mão no painel.
 *
 * ── ⚠️ Quem NÃO conseguia cancelar era justamente quem mais precisava ─────────
 * A rota exigia status ATIVA ou TESTE. Quem estava INADIMPLENTE, SUSPENSA ou ESTORNADA
 * recebia "não há assinatura ativa para cancelar" — e nesses três estados a recorrência
 * do Asaas pode estar VIVA, cobrando. O caso completo: o cliente contesta a cobrança, a
 * conta vai para ESTORNADA (acesso bloqueado), a cobrança seguia mensal, e o único botão
 * que a interromperia estava desligado. Cobrado, bloqueado e sem saída.
 *
 * Cancelar existe para PARAR A COBRANÇA. Então vale em qualquer estado — e em revisão de
 * contestação para a cobrança SEM destruir a revisão, porque o estado dela é o próprio
 * status e `canceledAt` é o relógio do prazo que a Política promete. Ver
 * `paradaDeCobrancaSemEncerrar`.
 */
export const POST = route(async (_req: NextRequest) => {
  const ctx = await requireAppContext();
  /**
   * Sem guarda de organização aqui: esta rota não a usa, e a conta sem organização também
   * não tem assinatura — então a recusa correta é a de baixo, que fala de assinatura. A
   * mensagem antiga ("Organização não encontrada") mandava o cliente procurar um problema
   * que não era o dele.
   */

  const sub = ctx.currentSubscription;
  if (!sub) return fail("Não há assinatura para cancelar.", 409);

  /** Em revisão de contestação: para a cobrança, preserva a revisão. */
  const emRevisao = sub.status === "SUSPENSA" || sub.status === "ESTORNADA";
  /** Já parada a pedido: não se manda segundo e-mail de cancelamento. */
  const jaHaviaPedido = sub.canceledByRequestAt !== null;

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    /**
     * `pedidoDeParada` grava o pedido num campo PRÓPRIO — e é ele que distingue,
     * quando um pagamento chega para assinatura cancelada, o dinheiro que reativa
     * (atraso pago) do dinheiro que tem de ser devolvido. Também apaga a promessa de
     * renovação e o downgrade agendado: quem pediu para parar não pode continuar vendo
     * "Próxima cobrança" na tela. Ver `canceladaAPedido`.
     *
     * Em revisão, a variante que NÃO mexe em status, motivo nem `canceledAt`: apagar
     * esses campos encerraria a revisão e reiniciaria o prazo dela em favor de quem
     * devia cumpri-lo.
     */
    data: emRevisao ? paradaDeCobrancaSemEncerrar() : pedidoDeParada(MOTIVO_CANCELAMENTO_CLIENTE),
  });

  /**
   * O gate é "existe recorrência a encerrar?", não "o provider é ASAAS".
   *
   * `provider` guarda o ÚLTIMO ator que tocou o registro: uma liberação manual pelo
   * painel o troca para MANUAL sem limpar `externalRef`, e a recorrência do Asaas
   * continua viva e cobrando. Com o gate no provider, o cancelamento pulava o gateway
   * em silêncio — e respondia ao cliente que não haveria novas cobranças.
   */
  const falhaNoGateway =
    ehRecorrencia(sub.externalRef) && asaasConfigured()
      ? await cancelarRecorrencia(sub.externalRef, {
          tipoEvento: "asaas_cancelamento_nao_efetivado",
          contexto: { motivo: "pedido_do_cliente", subscriptionId: sub.id, userId: ctx.user.id },
        })
      : undefined;

  await logAudit({
    actorId: ctx.user.id,
    action: "subscription.cancel_requested",
    entityType: "Subscription",
    entityId: sub.id,
    metadata: {
      provider: sub.provider,
      cobrancaInterrompida: !falhaNoGateway,
      estadoAnterior: sub.status,
      revisaoPreservada: emRevisao,
    },
  });

  /**
   * O e-mail é aviso, não parte do cancelamento: não pode derrubar a operação.
   *
   * Não sai quando o pedido já havia sido registrado antes (o cliente clicou de novo) nem
   * quando a assinatura está em revisão: ali a assinatura NÃO foi encerrada, e mandar
   * "cancelamento concluído, acesso até tal data" contradiria a tela, que mostra o
   * bloqueio e o prazo da revisão.
   */
  let avisoEmail: string | undefined;
  const avisarCliente = !jaHaviaPedido && !emRevisao;
  if (avisarCliente) {
    try {
      await sendCanceled({ email: ctx.user.email, name: ctx.user.name }, sub.currentPeriodEnd);
    } catch (err) {
      avisoEmail = (err as Error).message;
      console.error("[cancelar] assinatura cancelada, mas o e-mail NÃO foi enviado:", avisoEmail);
    }
  }

  const naoConfirmada =
    "Não conseguimos confirmar agora a interrupção da cobrança junto ao provedor de pagamento —" +
    " nossa equipe foi notificada e vai confirmar. Se aparecer nova cobrança, avise o suporte que devolvemos.";

  const message = emRevisao
    ? falhaNoGateway
      ? `Pedido registrado: não haverá novas cobranças. ${naoConfirmada} A revisão da contestação continua em andamento e o prazo dela não muda.`
      : "Cobrança interrompida: não haverá novas cobranças. A revisão da contestação continua em andamento e o prazo dela não muda."
    : falhaNoGateway
      ? `Cancelamento registrado e você mantém o acesso até o fim do período já pago. ${naoConfirmada}`
      : "Assinatura cancelada. Você mantém o acesso até o fim do período já pago e não haverá novas cobranças.";

  return ok({
    message,
    accessUntil: updated.currentPeriodEnd,
    cobrancaInterrompida: !falhaNoGateway,
    revisaoPreservada: emRevisao,
  });
});
