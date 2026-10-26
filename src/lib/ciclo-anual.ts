import { prisma } from "./db";
import { assinaturasComCotaNoMes, chaveDoCiclo, liberarCreditosDoCiclo } from "./credits";
import { logSecurityEvent } from "./audit";

/**
 * Liberação mensal de créditos do plano ANUAL.
 *
 * ── O defeito que isto conserta ───────────────────────────────────────────────
 * A liberação de créditos só acontecia em resposta a um PAGAMENTO: o webhook do
 * Asaas chama `liberarCreditosDoCiclo` na ativação e em cada renovação. No plano
 * mensal isso basta — chega um pagamento por mês. No ANUAL, a recorrência do Asaas
 * é YEARLY: chega UM evento por ano. E no anual pago por PIX não chega nenhum.
 *
 * Resultado: o cliente pagava R$ 419,00 pela oferta publicada de "20 análises por
 * mês" e recebia 20 análises no ANO. A partir do segundo mês ficava sem serviço, e o
 * painel exibia como próxima renovação uma data doze meses à frente. Enquanto a
 * oferta era ilimitada o defeito não aparecia (cota 0 libera sempre); voltou a
 * existir no instante em que a cota voltou.
 *
 * O campo `cycleEndsAt` era gravado a cada liberação e nunca lido por linha nenhuma
 * do sistema — o mecanismo tinha sido projetado e não ligado.
 *
 * ── Por que só o anual ────────────────────────────────────────────────────────
 * Varrer todas as assinaturas ativas criaria outro defeito: o cliente mensal que
 * paga dia 20 receberia cota nova no dia 1º — dezenove dias de crédito grátis — e a
 * liberação legítima do webhook, no dia 20, seria engolida pela chave do mês, que é
 * `ciclo:<id>:<AAAA-MM>`. O ciclo dele migraria de vez para o dia 1º. O mensal já
 * está coberto pelo pagamento.
 *
 * ── Por que ancorar no dia do contrato, e não no dia 1º ───────────────────────
 * A chave de idempotência é por MÊS CIVIL. Um anual contratado em 20/08/2026 paga
 * até 19/08/2027, e esse intervalo toca TREZE meses civis (08/2026 a 08/2027). Se a
 * liberação acontecesse no dia 1º, o contrato receberia treze cotas por doze meses
 * pagos — uma cota de brinde por cliente, todo ano. Ancorando no dia do contrato, o
 * mês só é liberado quando o aniversário chega, e as contas fecham.
 */

/** Último dia do mês de `d`, para o dia 31 não transbordar em fevereiro. */
function diaAncora(diaDoContrato: number, referencia: Date): number {
  const ultimoDia = new Date(Date.UTC(referencia.getUTCFullYear(), referencia.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.min(diaDoContrato, ultimoDia);
}

export interface ResultadoCicloAnual {
  liberadas: number;
  /** Assinaturas que ainda não chegaram ao dia do aniversário neste mês. */
  aguardando: number;
  detalhes: { subscriptionId: string; creditos: number }[];
}

/**
 * Libera a cota do mês corrente das assinaturas ANUAIS que já passaram do dia do
 * contrato e ainda não receberam.
 *
 * Idempotente duas vezes: pela chave do ciclo dentro de `liberarCreditosDoCiclo` e
 * pelo filtro que só seleciona quem ainda não tem o lançamento do mês.
 */
export async function liberarCiclosAnuais(referencia: Date = new Date()): Promise<ResultadoCicloAnual> {
  const chave = chaveDoCiclo(referencia);

  const anuais = await prisma.subscription.findMany({
    where: {
      status: "ATIVA",
      plan: { period: "ANUAL" },
      // Fora do período pago não há cota a liberar.
      OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gte: referencia } }],
    },
    select: { id: true, startedAt: true, analysesQuota: true, plan: { select: { monthlyAnalyses: true, name: true } } },
  });

  /**
   * "Já houve liberação de cota neste mês?" — pelo mesmo predicado do painel do
   * administrador, e não pela chave. A liberação nascida de PAGAMENTO usa a
   * identidade do pagamento na chave; procurar a chave do mês não a encontraria, e
   * esta rotina entregaria uma SEGUNDA cota justamente no mês em que o cliente pagou.
   */
  const jaFeitos = await assinaturasComCotaNoMes(anuais.map((s) => s.id), referencia);

  const detalhes: { subscriptionId: string; creditos: number }[] = [];
  let aguardando = 0;

  for (const sub of anuais) {
    // Cota 0 é plano legado ILIMITADO: não depende de liberação mensal.
    if (sub.plan.monthlyAnalyses <= 0) continue;
    if (jaFeitos.has(sub.id)) continue;

    const ancora = diaAncora(sub.startedAt.getUTCDate(), referencia);
    if (referencia.getUTCDate() < ancora) {
      aguardando++;
      continue;
    }

    try {
      const r = await liberarCreditosDoCiclo(sub.id, {
        referencia,
        descricao: `Créditos do mês liberados pelo plano anual ${sub.plan.name}`,
      });
      if (!r.jaLiberado) detalhes.push({ subscriptionId: sub.id, creditos: r.liberados });
    } catch (err) {
      /**
       * Falha em uma assinatura não pode interromper a varredura: as outras ficariam
       * sem a cota do mês por causa de um caso isolado. E fica registrado como evento
       * de segurança porque é cliente pagante sem o que comprou.
       */
      await logSecurityEvent({
        type: "ciclo_anual_nao_liberado",
        metadata: { subscriptionId: sub.id, erro: (err as Error).message, mes: chave },
      });
      console.error(`[ciclo-anual] assinatura ${sub.id} não recebeu a cota de ${chave}:`, (err as Error).message);
    }
  }

  return { liberadas: detalhes.length, aguardando, detalhes };
}
