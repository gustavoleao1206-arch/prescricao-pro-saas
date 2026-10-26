import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { prorrogarRevisao, restabelecerAcesso } from "@/lib/revisao-contestacao";
import {
  asaasConfigured,
  cancelarRecorrencia,
  ehRecorrencia,
  MOTIVO_CANCELAMENTO_ADMIN,
  paradaDeCobrancaSemEncerrar,
  pedidoDeParada,
} from "@/lib/asaas";
import { sendCanceled } from "@/lib/subscription-emails";
import { z } from "zod";

const schema = z.object({
  action: z.enum(["suspender", "reativar", "cancelar", "restabelecer", "prorrogar-revisao", "interromper-cobranca"]),
  observacao: z.string().max(500).optional(),
});

function addPeriod(period: string): Date {
  const d = new Date();
  if (period === "ANUAL") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

/**
 * Ações administrativas sobre uma assinatura (todas registradas em auditoria):
 *  - suspender: bloqueia o acesso (SUSPENSA).
 *  - reativar:  libera o acesso (ATIVA) e ESTENDE o período por um ciclo. É
 *               concessão comercial, não conserto de bloqueio.
 *  - cancelar:  encerra a renovação, mantendo acesso até currentPeriodEnd.
 *  - restabelecer: devolve o acesso de quem está em revisão de estorno ou suspenso,
 *               SEM tocar no período pago. Ver a distinção abaixo.
 *  - prorrogar-revisao: registra a prorrogação da revisão, uma única vez.
 *  - interromper-cobranca: PARA a cobrança no gateway sem encerrar a assinatura nem
 *               tocar na revisão. É a única saída para o cliente em ESTORNADA, que não
 *               consegue nem entrar na conta para cancelar.
 *
 * ── Por que "restabelecer" existe ao lado de "reativar" ───────────────────────
 * Eram a mesma coisa, e isso era um defeito. "Reativar" soma um ciclo inteiro ao
 * período: usá-la para desfazer um bloqueio de estorno daria ao cliente um mês de
 * graça e faria a data da próxima cobrança mentir. Os Termos e a Política de
 * Cancelamento prometem que a revisão termina em prazo certo e que, esgotado o prazo
 * sem decisão, o acesso volta — promessa que exigia uma ação que devolvesse o acesso
 * e nada além dele. Ver src/lib/revisao-contestacao.ts.
 */
export const PATCH = route(async (req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const admin = await requireRole("ADMIN");
  const { action, observacao } = schema.parse(await req.json());

  const sub = await prisma.subscription.findUnique({ where: { id: params.id }, include: { plan: true } });
  if (!sub) return fail("Assinatura não encontrada.", 404);

  if (action === "restabelecer") {
    const r = await restabelecerAcesso(sub.id, { motivo: "decisao", actorId: admin.id, observacao });
    if (!r.restabelecida) {
      return fail(
        r.recusa === "estado_nao_permite"
          ? `Só é possível restabelecer assinatura SUSPENSA ou ESTORNADA. Esta está ${sub.status}.`
          : "Assinatura não encontrada.",
        r.recusa === "estado_nao_permite" ? 409 : 404,
      );
    }
    return ok({
      id: sub.id,
      status: "ATIVA",
      creditosDesbloqueados: r.creditosDesbloqueados ?? 0,
      message:
        `Acesso restabelecido sem alterar o período pago` +
        (r.creditosDesbloqueados ? `, com ${r.creditosDesbloqueados} crédito(s) desbloqueado(s)` : "") +
        (r.avisoEnviado ? ". O cliente foi avisado por e-mail." : ". ATENÇÃO: o aviso por e-mail não saiu."),
    });
  }

  /**
   * ⚠️ INTERROMPER A COBRANÇA sem encerrar a assinatura.
   *
   * Existe para o caso que não tinha saída nenhuma. Recebido um estorno ou chargeback, a
   * conta vai para ESTORNADA: o acesso cai, os créditos são bloqueados — e o LOGIN é
   * recusado. O cliente não consegue entrar para clicar em "cancelar", e "cancelar" pelo
   * painel é (corretamente) recusado durante a revisão, porque destruiria o estado dela e
   * o prazo que a Política promete.
   *
   * Resultado: cliente bloqueado, sendo cobrado todo mês, sem nenhum botão em lugar
   * nenhum que interrompesse a cobrança. Esta ação faz só isso — para a cobrança e
   * preserva a revisão inteira. Vale em qualquer estado, porque parar de cobrar nunca
   * prejudica o assinante.
   */
  if (action === "interromper-cobranca") {
    const temRecorrencia = ehRecorrencia(sub.externalRef);
    await prisma.subscription.update({ where: { id: sub.id }, data: paradaDeCobrancaSemEncerrar() });

    const falhou =
      temRecorrencia && asaasConfigured()
        ? await cancelarRecorrencia(sub.externalRef, {
            tipoEvento: "asaas_cancelamento_nao_efetivado",
            contexto: { motivo: "interrupcao_de_cobranca_pelo_admin", subscriptionId: sub.id, adminId: admin.id },
          })
        : undefined;

    await logAudit({
      actorId: admin.id,
      actorRole: "ADMIN",
      action: "admin.subscription.interromper_cobranca",
      entityType: "Subscription",
      entityId: sub.id,
      metadata: { status: sub.status, cobrancaInterrompida: !falhou && temRecorrencia, observacao: observacao ?? null },
    });

    return ok({
      id: sub.id,
      status: sub.status,
      cobrancaInterrompida: !temRecorrencia || !falhou,
      message:
        (falhou
          ? `ATENÇÃO: não conseguimos confirmar a interrupção no Asaas (${falhou}). Encerre a recorrência à mão no painel do Asaas.`
          : temRecorrencia
            ? "Cobrança interrompida no Asaas."
            : "Não havia cobrança recorrente a interromper (pagamento único).") +
        ` O estado da assinatura (${sub.status}) não foi alterado` +
        (sub.status === "ESTORNADA" ? ", nem o prazo da revisão." : "."),
    });
  }

  if (action === "prorrogar-revisao") {
    const r = await prorrogarRevisao(sub.id, { actorId: admin.id, observacao });
    if (!r.prorrogada) {
      const motivos = {
        ja_prorrogada: "Esta revisão já foi prorrogada uma vez, e a Política admite apenas uma.",
        estado_nao_permite:
          `Só há prazo de revisão a prorrogar em assinatura ESTORNADA — é o prazo da contestação de` +
          ` cobrança. Esta está ${sub.status}; suspensão administrativa não volta por decurso de prazo.`,
        nao_encontrada: "Assinatura não encontrada.",
      };
      return fail(motivos[r.recusa ?? "nao_encontrada"], r.recusa === "nao_encontrada" ? 404 : 409);
    }
    return ok({
      id: sub.id,
      novoPrazo: r.novoPrazo ?? null,
      message: "Prorrogação registrada. Comunique o motivo ao assinante, como a Política exige.",
    });
  }

  /**
   * Cancelar tem guarda de estado, e não é formalidade.
   *
   * Já CANCELADA: repetir a ação mandaria ao cliente um segundo e-mail de
   * cancelamento e reescreveria a data do pedido de parada.
   *
   * SUSPENSA ou ESTORNADA: a assinatura está em REVISÃO de contestação, com prazo que
   * a Política de Cancelamento publica e promete cumprir. Cancelar apaga o estado da
   * revisão — e com ele o direito do assinante ao restabelecimento por decurso de
   * prazo. Quem quer encerrar durante uma revisão decide a revisão primeiro
   * (restabelecer) ou espera o prazo.
   */
  if (action === "cancelar") {
    if (sub.status === "CANCELADA") {
      return fail("Esta assinatura já está cancelada.", 409);
    }
    if (sub.status === "SUSPENSA" || sub.status === "ESTORNADA") {
      return fail(
        `Esta assinatura está em revisão de contestação (${sub.status}). Decida a revisão primeiro —` +
          " restabelecer o acesso ou aguardar o prazo — e só então cancele.",
        409,
      );
    }
  }

  let data: Record<string, unknown>;
  if (action === "suspender") {
    data = { status: "SUSPENSA", suspendedAt: new Date() };
  } else if (action === "cancelar") {
    // Campo próprio para o pedido de parada, e fim da promessa de renovação na tela do
    // cliente. Ver `pedidoDeParada`, em src/lib/asaas.ts.
    data = pedidoDeParada(MOTIVO_CANCELAMENTO_ADMIN);
  } else {
    data = {
      status: "ATIVA",
      reactivatedAt: new Date(),
      suspendedAt: null,
      canceledAt: null,
      canceledReason: null,
      currentPeriodEnd: addPeriod(sub.plan.period),
    };
  }

  const updated = await prisma.subscription.update({ where: { id: sub.id }, data });

  /**
   * ⚠️ Cancelar no painel TEM de falar com o Asaas.
   *
   * Este era o defeito mais caro da tela: a ação só gravava CANCELADA no nosso banco.
   * A recorrência continuava viva no gateway, o cartão do cliente seguia sendo
   * debitado todo mês — e cada débito ressuscitava a assinatura, porque o caminho de
   * renovação do webhook gravava ATIVA sem perguntar por que ela estava cancelada.
   * O admin cancelava, via a assinatura voltar sozinha, cancelava de novo, e o
   * cliente pagava no meio disso. A rota de cancelamento do CLIENTE já falava com o
   * gateway desde o conserto anterior; a do painel ficou para trás.
   *
   * Ordem deliberada: grava primeiro, avisa o gateway depois. Indisponibilidade do
   * Asaas não pode fazer o cancelamento se perder — mas também não pode ser
   * escondida, então a resposta diz o que não foi confirmado e fica registrado para
   * alguém encerrar à mão no painel do Asaas.
   */
  /**
   * O gate é "existe recorrência a encerrar?", e não "o provider é ASAAS".
   *
   * `provider` guarda o ÚLTIMO ator que tocou o registro. `ativacaoManual` o troca para
   * MANUAL — e NÃO limpa `externalRef`: a recorrência do Asaas continua viva e
   * cobrando. Com o gate no provider, este cancelamento pulava o gateway em silêncio e
   * a mensagem ainda afirmava "a cobrança recorrente foi encerrada no Asaas". Mentira
   * exatamente no lugar que existe para não mentir.
   */
  const temRecorrencia = ehRecorrencia(sub.externalRef);
  const falhaNoGateway =
    action === "cancelar" && temRecorrencia && asaasConfigured()
      ? await cancelarRecorrencia(sub.externalRef, {
          tipoEvento: "asaas_cancelamento_nao_efetivado",
          contexto: { motivo: "acao_do_administrador", subscriptionId: sub.id, adminId: admin.id },
        })
      : undefined;
  /** Houve chamada ao gateway? Sem isso não se pode AFIRMAR que a cobrança parou. */
  const gatewayConsultado = action === "cancelar" && temRecorrencia && asaasConfigured();

  /**
   * "Não existe mais cobrança recorrente em vigor" — e é isso que a resposta afirma.
   *
   * Verdadeiro também quando nunca houve recorrência (PIX é cobrança única): dizer
   * `false` ali seria alarme falso no caminho normal de quem pagou por PIX. Falso
   * quando existe recorrência e não conseguimos, ou não pudemos, encerrá-la.
   */
  const semCobrancaRecorrente = !temRecorrencia || (gatewayConsultado && !falhaNoGateway);

  await logAudit({
    actorId: admin.id,
    actorRole: "ADMIN",
    action: `admin.subscription.${action}`,
    entityType: "Subscription",
    entityId: sub.id,
    metadata: {
      from: sub.status,
      to: updated.status,
      observacao: observacao ?? null,
      ...(action === "cancelar" ? { cobrancaInterrompida: semCobrancaRecorrente } : {}),
    },
  });

  /**
   * Cancelamento feito por nós exige aviso escrito ao assinante.
   *
   * A Política de Cancelamento promete confirmação do encerramento e a data até a
   * qual o acesso continua valendo. Quando é o cliente que cancela, ele recebe esse
   * e-mail; cancelado pelo painel, ele não recebia nada e descobriria pelo bloqueio.
   * O envio é aviso, não parte do cancelamento: falhar não derruba a ação.
   */
  let avisoEmail: string | undefined;
  /**
   * `undefined` = não havia a quem avisar. Distinto de "avisado" e de "falhou": sem os
   * três estados a mensagem afirmava "O cliente foi avisado por e-mail" também quando
   * a organização não tem dono e nenhum e-mail foi sequer tentado.
   */
  let clienteAvisado: boolean | undefined;
  if (action === "cancelar") {
    const dono = await prisma.organization.findUnique({
      where: { id: sub.organizationId },
      select: { owner: { select: { email: true, name: true } } },
    });
    if (dono?.owner) {
      try {
        await sendCanceled({ email: dono.owner.email, name: dono.owner.name }, updated.currentPeriodEnd);
        clienteAvisado = true;
      } catch (err) {
        avisoEmail = (err as Error).message;
        clienteAvisado = false;
        console.error("[admin] assinatura cancelada, mas o e-mail ao cliente NÃO saiu:", avisoEmail);
      }
    }
  }

  return ok({
    id: updated.id,
    status: updated.status,
    ...(action === "cancelar" ? { cobrancaInterrompida: semCobrancaRecorrente } : {}),
    message: mensagemDaAcao(action, {
      falhaNoGateway,
      avisoEmail,
      clienteAvisado,
      gatewayConsultado,
      recorrencia: temRecorrencia,
      acessoAte: updated.currentPeriodEnd,
    }),
  });
});

/** O que dizer ao administrador — sem prometer o que não foi confirmado. */
function mensagemDaAcao(
  action: "suspender" | "reativar" | "cancelar",
  ctx: {
    falhaNoGateway?: string;
    avisoEmail?: string;
    clienteAvisado?: boolean;
    gatewayConsultado: boolean;
    recorrencia: boolean;
    acessoAte: Date | null;
  },
): string {
  if (action === "suspender") {
    /**
     * Suspender bloqueia o ACESSO e nada mais — a recorrência do Asaas segue cobrando.
     *
     * A versão anterior desta mensagem avisava que "o pagamento do próximo ciclo reativa a
     * assinatura", porque era o que acontecia. Deixou de acontecer por decisão do dono:
     * pagar não desfaz suspensão administrativa. O que sobra, e que continua precisando
     * ser dito, é que a suspensão não interrompe a cobrança — então o cliente segue sendo
     * debitado por um serviço que não pode usar, e isso não pode durar.
     */
    return (
      "Assinatura suspensa: o acesso está bloqueado agora, e o pagamento NÃO desfaz a" +
      " suspensão. ATENÇÃO: a cobrança também não é interrompida — o cliente continua sendo" +
      " debitado sem poder usar. Para parar a cobrança sem encerrar o contrato, use" +
      " Interromper cobrança; para encerrar, use Cancelar."
    );
  }

  if (action === "reativar") {
    /**
     * Honestidade sobre o que "Liberar" faz e o que não faz: ela devolve o ACESSO e
     * soma um ciclo, mas não recria a cobrança no Asaas. Sem este aviso, uma
     * assinatura cuja recorrência já foi encerrada volta a parecer normal no painel e
     * nunca mais gera receita — e ninguém descobre até conferir o extrato.
     */
    return (
      "Acesso liberado com um ciclo adicional. A cobrança automática NÃO é recriada:" +
      " se a recorrência já foi encerrada no Asaas, o próximo ciclo não será cobrado."
    );
  }

  const ate = ctx.acessoAte ? ` O acesso vale até ${ctx.acessoAte.toLocaleDateString("pt-BR")}.` : "";

  /**
   * Quatro estados, porque três eram poucos para não mentir: encerrada de fato,
   * tentada e não confirmada, NÃO TENTADA (há recorrência mas o Asaas não está
   * configurado) e inexistente (pagamento único).
   */
  const cobranca = ctx.falhaNoGateway
    ? " ATENÇÃO: não conseguimos confirmar a interrupção da cobrança no Asaas" +
      ` (${ctx.falhaNoGateway}). Encerre a recorrência à mão no painel do Asaas.`
    : ctx.gatewayConsultado
      ? " A cobrança recorrente foi encerrada no Asaas."
      : ctx.recorrencia
        ? " ATENÇÃO: existe uma recorrência no Asaas e ela NÃO foi encerrada por aqui" +
          " (integração indisponível). Encerre-a à mão no painel do Asaas."
        : " Não havia cobrança recorrente a encerrar (pagamento único).";

  const email =
    ctx.clienteAvisado === true
      ? " O cliente foi avisado por e-mail."
      : ctx.clienteAvisado === false
        ? ` O e-mail ao cliente não saiu: ${ctx.avisoEmail}`
        : " ATENÇÃO: esta organização não tem titular cadastrado — ninguém foi avisado.";

  return `Assinatura cancelada.${ate}${cobranca}${email}`;
}
