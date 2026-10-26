import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireAppContext } from "@/lib/tenant";
import { logAudit } from "@/lib/audit";
import { asaasConfigured, atualizarValorDaRecorrencia, criarCheckout, ehRecorrencia } from "@/lib/asaas";
import {
  calcularProporcional,
  planoTrocavel,
  agendarDowngrade,
  aplicarUpgrade,
} from "@/lib/mudanca-plano";

export const runtime = "nodejs";

const corpo = z.object({ planoSlug: z.string().min(1, "Informe o plano de destino.") });

/**
 * Mudança de plano pelo cliente, com cálculo proporcional.
 *
 * Três desfechos possíveis, e a tela precisa distinguir os três:
 *  - "downgrade"        → nada a pagar; o plano menor passa a valer no fim do ciclo;
 *  - "upgrade-imediato" → a diferença proporcional ficou abaixo do piso de
 *                         cobrança e o upgrade foi aplicado sem cobrar;
 *  - "upgrade"          → devolve o link de pagamento da diferença proporcional. O
 *                         plano só sobe quando o webhook confirmar o pagamento.
 *
 * Restrito a assinatura do Asaas de propósito: em MANUAL a venda foi feita fora do
 * gateway, então não há como cobrar a diferença proporcional nem atualizar a
 * recorrência. Prometer a troca nesse caso seria prometer o que o sistema não
 * cumpre — vai para o atendimento, com o motivo explicado.
 */
export const POST = route(async (req: NextRequest) => {
  const ctx = await requireAppContext();
  /**
   * Sem guarda de organização aqui: esta rota não a usa, e a conta sem organização também
   * não tem assinatura — então a recusa correta é a de baixo, que fala de assinatura. A
   * mensagem antiga ("Organização não encontrada") mandava o cliente procurar um problema
   * que não era o dele.
   */

  const sub = ctx.currentSubscription;
  if (!sub || sub.status !== "ATIVA") {
    return fail("A mudança de plano exige uma assinatura ativa.", 409);
  }
  if (sub.provider !== "ASAAS") {
    return fail(
      "Esta assinatura não foi contratada pelo pagamento online, então a troca de plano precisa passar pelo atendimento. Fale com o suporte.",
      409,
    );
  }

  const dados = corpo.safeParse(await req.json().catch(() => null));
  if (!dados.success) return fail(dados.error.issues[0]?.message ?? "Dados inválidos.", 422);

  const [atual, novo] = await Promise.all([
    prisma.plan.findUnique({ where: { id: sub.planId } }),
    prisma.plan.findUnique({ where: { slug: dados.data.planoSlug } }),
  ]);
  if (!novo) return fail("Plano de destino não encontrado.", 404);
  if (!atual) return fail("Plano atual não encontrado.", 409);
  if (novo.id === atual.id) return fail("Você já está neste plano.", 409);
  if (!planoTrocavel(novo)) {
    return fail("Este plano não pode ser contratado por aqui. Fale com o atendimento comercial.", 400);
  }
  if (!planoTrocavel(atual)) {
    return fail("Seu plano atual precisa ser tratado pelo atendimento para mudar. Fale com o suporte.", 409);
  }

  const conta = calcularProporcional(atual, novo, sub);

  // --- Downgrade: sem cobrança agora, vale no fim do ciclo pago -------------
  if (!conta.ehUpgrade) {
    const agendamento = await agendarDowngrade(sub.id, novo.id, ctx.user);

    /**
     * ⚠️ A COBRANÇA tem de ser reprogramada aqui, no agendamento.
     *
     * Antes, o downgrade só mexia no nosso banco: a recorrência do Asaas continuava no
     * valor e na periodicidade do plano antigo para sempre. Numa troca de faixa isso
     * vazava a diferença todo mês; na troca de ANUAL para MENSAL o resultado era
     * grotesco — na renovação o Asaas cobrava os R$ 419,00 do anual, o sistema aplicava
     * o plano mensal e registrava 30 dias. O cliente pagava um ANO e ficava sem acesso
     * em um MÊS, e a cobrança seguinte só voltaria doze meses depois.
     *
     * `nextDueDate` vai junto e é o que mantém a promessa "nada muda até o fim do
     * período pago": sem ela, mudar a periodicidade da recorrência faria o Asaas
     * reagendar a próxima cobrança pela nova regra — cobrando o cliente antes da hora.
     */
    const recorrenciaDesatualizada =
      ehRecorrencia(sub.externalRef) && asaasConfigured()
        ? await atualizarValorDaRecorrencia(sub.externalRef, novo, agendamento.valeApartirDe)
        : undefined;

    const quando = agendamento.valeApartirDe
      ? ` a partir de ${agendamento.valeApartirDe.toLocaleDateString("pt-BR")}`
      : " na renovação";

    /**
     * Trocar a periodicidade merece frase própria: quem sai do anual para o mensal passa
     * a pagar todo mês, e o valor total do ano sobe. Dizer só "o novo valor passa a ser
     * cobrado" esconde isso atrás de um número menor.
     */
    const explicacao = agendamento.mudaPeriodicidade
      ? `A periodicidade também muda: a cobrança passa a ser ${novo.period === "ANUAL" ? "anual" : "mensal"}` +
        `, de ${(novo.priceCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}${quando}.`
      : `O novo valor passa a ser cobrado${quando}.`;

    return ok({
      tipo: "downgrade",
      plano: novo.name,
      valeApartirDe: agendamento.valeApartirDe,
      cobrancaAjustada: !recorrenciaDesatualizada,
      message:
        `Mudança para ${novo.name} agendada. Você continua com o plano atual e os créditos deste ciclo até ` +
        `o fim do período já pago. ${explicacao}` +
        (recorrenciaDesatualizada
          ? " ATENÇÃO: não conseguimos confirmar agora o ajuste da cobrança junto ao provedor de pagamento —" +
            " nossa equipe foi notificada. Se a próxima cobrança vier no valor antigo, avise o suporte que" +
            " devolvemos a diferença."
          : ""),
    });
  }

  // --- Upgrade com diferença abaixo do piso: aplica sem cobrar --------------
  if (conta.valorCents <= 0) {
    const r = await aplicarUpgrade(sub.id, novo.id, {
      // Um upgrade dispensado por ciclo: a chave usa o fim do período, então
      // reenvio de formulário ou duplo clique não soma cota duas vezes.
      chaveIdempotencia: `upgrade-dispensado:${sub.id}:${novo.id}:${sub.currentPeriodEnd?.toISOString() ?? "sem-ciclo"}`,
      motivo: conta.cobrancaDispensada
        ? `Upgrade com diferença proporcional abaixo do piso de cobrança (${conta.diasRestantes} dia(s) restantes)`
        : `Upgrade sem diferença a cobrar (${conta.diasRestantes} dia(s) restantes)`,
      atorId: ctx.user.id,
      novoCicloAte: conta.novoCicloAte,
    });
    return ok({
      tipo: "upgrade-imediato",
      plano: novo.name,
      creditosAdicionais: r.creditosAdicionais,
      message: r.aplicado
        ? `Plano alterado para ${novo.name} sem cobrança agora, porque faltam poucos dias para a renovação. ` +
          `${r.creditosAdicionais > 0 ? `Você recebeu ${r.creditosAdicionais} crédito(s) adicionais neste ciclo. ` : ""}` +
          `O valor do novo plano passa a ser cobrado na próxima renovação.`
        : "Este upgrade já havia sido aplicado.",
    });
  }

  // --- Upgrade pago: cobrança avulsa da diferença proporcional --------------
  if (!asaasConfigured()) {
    return fail("O pagamento online não está configurado. Fale com o suporte para mudar de plano.", 503);
  }

  try {
    const { url } = await criarCheckout({
      tipo: "upgrade",
      slug: novo.slug,
      nome: `Upgrade para ${novo.name} — ${conta.diasRestantes} dia(s) restantes do ciclo`,
      valorCents: conta.valorCents,
      userId: ctx.user.id,
    });
    await logAudit({
      actorId: ctx.user.id,
      action: "subscription.upgrade_checkout_opened",
      entityType: "Subscription",
      entityId: sub.id,
      metadata: {
        de: atual.slug,
        para: novo.slug,
        valorCents: conta.valorCents,
        diasRestantes: conta.diasRestantes,
      },
    });
    return ok({
      tipo: "upgrade",
      plano: novo.name,
      valorCents: conta.valorCents,
      creditosAdicionais: conta.creditosAdicionais,
      url,
    });
  } catch (err) {
    const motivo = (err as Error).message;
    console.error("[mudar-plano] falha ao criar a cobrança do upgrade:", motivo);
    // O motivo cru do provedor é operacional e não ajuda o comprador; o admin vê.
    if (ctx.user.role === "ADMIN") return fail(`Asaas recusou a cobrança do upgrade: ${motivo}`, 502);
    return fail("Não foi possível gerar a cobrança agora. Tente novamente em instantes.", 502);
  }
});
