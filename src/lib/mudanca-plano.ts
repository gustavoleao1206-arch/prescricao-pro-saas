import { prisma } from "./db";
import { logAudit } from "./audit";
import type { Plan, Subscription } from "@prisma/client";

/**
 * Mudança de plano com cálculo proporcional.
 *
 * ── O problema ────────────────────────────────────────────────────────────────
 * Até aqui, trocar de plano significava passar pelo checkout de novo. O checkout
 * cobra o valor CHEIO do plano novo na hora, em cima do mês que o cliente já
 * pagou — e cria uma segunda cobrança recorrente no Asaas, que continua rodando
 * ao lado da antiga. Quem subisse do Essencial (R$ 39,90) para o Profissional
 * (R$ 119,90) no dia 20 pagava R$ 119,90 imediatamente por 10 dias de plano, e no
 * mês seguinte era cobrado duas vezes.
 *
 * ── A regra ───────────────────────────────────────────────────────────────────
 * UPGRADE cobra apenas a DIFERENÇA entre os planos, proporcional aos dias que
 * faltam do ciclo já pago. Sobem juntos os créditos: a cota recebe a diferença
 * CHEIA de créditos, sem proporcionalidade e sem zerar o consumo.
 *
 * A cota vem cheia de propósito, mesmo pagando fração: crédito de plano expira no
 * fim do ciclo, então "proporcionalizar" a cota entregaria menos crédito por
 * menos dias — o cliente pagaria a diferença e mal notaria a mudança. Cobrar
 * proporcional e entregar a cota inteira é o critério generoso, e é o mesmo que a
 * troca de plano pelo checkout também aplica.
 *
 * DOWNGRADE não cobra nada e não tira nada: o ciclo em curso foi pago no plano
 * maior, então a cota atual continua valendo até o fim dele. O plano menor fica
 * agendado (`pendingPlanId`) e passa a valer na renovação.
 *
 * ── Troca de PERIODICIDADE é outra conta ──────────────────────────────────────
 * A oferta passou a ser um plano único SEM LIMITE em duas periodicidades, então a
 * troca típica virou mensal ↔ anual. Isso NÃO é "pagar a diferença pelos dias
 * restantes": é contratar um período novo. Mensal → anual cobra o preço do anual
 * abatendo o valor não usado do mês já pago, e o ciclo passa a ser de um ano.
 * Anual → mensal é agendado para o fim do ano pago, sem devolução.
 *
 * ── Cota 0 é SEM LIMITE, não zero ─────────────────────────────────────────────
 * Nos planos atuais a cota é 0, que em todo o sistema significa ilimitado
 * (`saldoDe`, `temSaldo`, `consumirCreditos`). Por isso não há diferença de cota a
 * somar quando qualquer um dos lados é ilimitado — ver `cotaAdicional`.
 */

/**
 * Piso de cobrança. Abaixo disso o upgrade é aplicado sem cobrar.
 *
 * Não é generosidade gratuita: gateway recusa cobrança de valor muito baixo, e o
 * cliente que clica em "mudar plano" e recebe erro do provedor não tenta de novo.
 * Sai mais barato aplicar a diferença de centavos — a renovação seguinte já cobra
 * o valor cheio do plano novo. Ajuste aqui se o piso do provedor mudar.
 */
export const MINIMO_COBRANCA_CENTS = 500;

/** Dias considerados no ciclo, por período do plano. */
export function diasDoPeriodo(period: string | null | undefined): number {
  return period === "ANUAL" ? 365 : 30;
}

/**
 * Subir de plano é pagar MAIS. É o preço que decide, e só ele.
 *
 * ── Por que isto virou função exportada ───────────────────────────────────────
 * Duas partes do sistema respondiam a esta pergunta, com critérios diferentes: o
 * cálculo proporcional comparava PREÇO, e a troca pelo checkout (`trocarPlano`, em
 * src/lib/asaas.ts) comparava COTA DE CRÉDITOS. Enquanto os planos tinham cotas
 * diferentes as duas concordavam por acidente.
 *
 * A oferta atual são dois planos com a MESMA cota — 20 análises/mês — em duas
 * periodicidades. Comparar cota passou a devolver sempre "é upgrade" (20 >= 20), e o
 * estrago era grande: quem tinha o anual pago até agosto e comprava o mensal pela página
 * de planos caía no ramo de upgrade, que recomeça o período em UM MÊS a partir de hoje.
 * Onze meses de serviço já pago desapareciam num clique.
 *
 * Cota nunca foi o critério certo, nem antes: plano mais caro com a mesma cota (suporte,
 * usuários, periodicidade) é upgrade, e cota igual não diz nada sobre dinheiro.
 */
export function ehSubidaDePlano(
  atual: Pick<Plan, "priceCents">,
  novo: Pick<Plan, "priceCents">,
): boolean {
  return novo.priceCents >= atual.priceCents;
}

export interface Proporcional {
  ehUpgrade: boolean;
  /** Duração do ciclo em dias (30 no mensal, 365 no anual). */
  diasNoCiclo: number;
  /** Dias que faltam do ciclo já pago. */
  diasRestantes: number;
  fracaoRestante: number;
  /** Diferença cheia entre os planos, para exibir a conta ao cliente. */
  diferencaCheiaCents: number;
  /** O que será efetivamente cobrado agora (0 em downgrade). */
  valorCents: number;
  /** Créditos somados à cota do ciclo corrente (0 em downgrade). */
  creditosAdicionais: number;
  /** Verdadeiro quando o proporcional ficou abaixo do piso e foi dispensado. */
  cobrancaDispensada: boolean;
  /** Quando a mudança passa a valer: agora (upgrade) ou o fim do ciclo (downgrade). */
  valeApartirDe: Date | null;
  /**
   * Verdadeiro quando muda a PERIODICIDADE (mensal ↔ anual), não a faixa do plano.
   * A conta é outra — ver `calcularProporcional`.
   */
  mudaPeriodo: boolean;
  /**
   * Novo fim de ciclo, quando a troca inicia um período novo (mensal → anual).
   * Nulo quando o ciclo pago continua o mesmo.
   */
  novoCicloAte: Date | null;
  /** Valor não utilizado do ciclo atual, abatido na troca de periodicidade. */
  creditoDoCicloAtualCents: number;
}

type PlanoParaCalculo = Pick<Plan, "priceCents" | "monthlyAnalyses" | "period">;

/**
 * Calcula o proporcional da troca. Função pura: não toca banco nem provedor, para
 * a conta que o cliente vê na tela poder ser testada sem infraestrutura.
 *
 * O eixo que decide upgrade/downgrade é o PREÇO, não a cota: é o preço que define
 * se há diferença a cobrar. Num catálogo coerente os dois andam juntos; se algum
 * dia houver plano mais barato com mais crédito, ele cai no caminho do downgrade
 * (não cobra, agenda) — que é o comportamento seguro para o cliente.
 */
export function calcularProporcional(
  atual: PlanoParaCalculo,
  novo: PlanoParaCalculo,
  sub: Pick<Subscription, "currentPeriodEnd">,
  agora: Date = new Date(),
): Proporcional {
  const fim = sub.currentPeriodEnd;
  const mudaPeriodo = (novo.period ?? null) !== (atual.period ?? null);

  /**
   * O ciclo de referência é o do plano ATUAL, porque é ele que o cliente já pagou
   * e é dele que sobram dias. Usar o período do plano novo produzia absurdo na
   * troca de periodicidade: mensal → anual com 20 dias restantes calculava
   * `20/365` e cobrava R$ 20 por um ano inteiro de plano.
   */
  const diasNoCiclo = diasDoPeriodo(atual.period);
  const brutos = fim ? Math.ceil((fim.getTime() - agora.getTime()) / 86_400_000) : 0;
  const diasRestantes = Math.max(0, Math.min(diasNoCiclo, brutos));
  const fracaoRestante = diasNoCiclo > 0 ? diasRestantes / diasNoCiclo : 0;

  const ehUpgrade = ehSubidaDePlano(atual, novo);

  // --- Descer de plano ou de periodicidade: nunca cobra, sempre agenda --------
  if (!ehUpgrade) {
    return {
      ehUpgrade: false,
      diasNoCiclo,
      diasRestantes,
      fracaoRestante,
      diferencaCheiaCents: 0,
      valorCents: 0,
      creditosAdicionais: 0,
      cobrancaDispensada: false,
      valeApartirDe: fim,
      mudaPeriodo,
      novoCicloAte: null,
      creditoDoCicloAtualCents: 0,
    };
  }

  /**
   * ── Troca de PERIODICIDADE (mensal → anual) ─────────────────────────────────
   *
   * Não é "pagar a diferença pelos dias que faltam": o cliente está contratando um
   * período NOVO, de um ano, que começa agora. Então cobra-se o preço do anual
   * ABATENDO o que sobrou do mês já pago — o valor proporcional aos dias não
   * usados. Quem troca no dia 10 de um mês de 30 dias, pagando R$ 49,90, tem
   * R$ 33,27 de crédito e paga R$ 385,73 pelo ano.
   *
   * Abater é questão de justiça, não de generosidade: sem isso o cliente pagaria
   * duas vezes pelos mesmos dias.
   */
  if (mudaPeriodo) {
    const creditoDoCicloAtualCents = Math.round(atual.priceCents * fracaoRestante);
    const aCobrar = Math.max(0, novo.priceCents - creditoDoCicloAtualCents);
    const dispensada = aCobrar > 0 && aCobrar < MINIMO_COBRANCA_CENTS;
    const novoCicloAte = new Date(agora);
    novoCicloAte.setDate(novoCicloAte.getDate() + diasDoPeriodo(novo.period));

    return {
      ehUpgrade: true,
      diasNoCiclo,
      diasRestantes,
      fracaoRestante,
      // O "cheio" aqui é o preço do período novo, não a diferença entre faixas.
      diferencaCheiaCents: novo.priceCents,
      valorCents: dispensada ? 0 : aCobrar,
      creditosAdicionais: cotaAdicional(atual, novo),
      cobrancaDispensada: dispensada,
      valeApartirDe: null,
      mudaPeriodo: true,
      novoCicloAte,
      creditoDoCicloAtualCents,
    };
  }

  // --- Mesma periodicidade: paga a diferença entre as faixas ------------------
  const diferencaCheiaCents = Math.max(0, novo.priceCents - atual.priceCents);
  const proporcional = Math.round(diferencaCheiaCents * fracaoRestante);
  const cobrancaDispensada = proporcional > 0 && proporcional < MINIMO_COBRANCA_CENTS;

  return {
    ehUpgrade: true,
    diasNoCiclo,
    diasRestantes,
    fracaoRestante,
    diferencaCheiaCents,
    valorCents: cobrancaDispensada ? 0 : proporcional,
    creditosAdicionais: cotaAdicional(atual, novo),
    cobrancaDispensada,
    valeApartirDe: null,
    mudaPeriodo: false,
    novoCicloAte: null,
    creditoDoCicloAtualCents: 0,
  };
}

/**
 * Créditos a somar na cota do ciclo corrente.
 *
 * Cota 0 é SEM LIMITE, não zero. Se o plano novo é ilimitado, não há diferença a
 * somar — a cota vira 0 e o sistema passa a liberar sempre. Fazer a subtração
 * ingênua (`0 - 6`) daria negativo e, pior, tratar o ilimitado como se fosse cota
 * numérica faria o cliente perder o "sem limite".
 */
function cotaAdicional(atual: PlanoParaCalculo, novo: PlanoParaCalculo): number {
  if (novo.monthlyAnalyses === 0 || atual.monthlyAnalyses === 0) return 0;
  return Math.max(0, novo.monthlyAnalyses - atual.monthlyAnalyses);
}

/**
 * Plano elegível para troca pela tela do cliente.
 *
 * Antes exigia cota maior que zero, para excluir o "ilimitado legado". A oferta
 * mudou: os dois planos vendidos hoje são SEM LIMITE (cota 0), então aquela regra
 * passaria a recusar todo mundo e a tela de mudar plano ficaria inútil.
 *
 * O que sobra como critério é o que sempre importou: plano ativo e que não seja
 * vendido por contrato — porque plano sob consulta tem condição negociada e não
 * cabe em cálculo automático.
 */
export function planoTrocavel(plano: Pick<Plan, "active" | "contactOnly">): boolean {
  return plano.active && !plano.contactOnly;
}

// ---------------------------------------------------------------------------
// Aplicação
// ---------------------------------------------------------------------------

/**
 * Agenda o downgrade para o fim do ciclo pago.
 *
 * Nada muda agora no ACESSO, de propósito: o cliente pagou o ciclo no plano maior e
 * tirar a cota no meio do caminho seria cobrar por um serviço e entregar outro.
 *
 * ── Mas a COBRANÇA tinha de ser reprogramada, e não era ───────────────────────
 * O agendamento gravava dois campos no nosso banco e mais nada. A recorrência do Asaas
 * continuava no valor e na periodicidade do plano ANTIGO, para sempre. No downgrade de
 * faixa isso vazava a diferença todo mês; na troca de ANUAL para MENSAL o resultado era
 * grotesco: na renovação o Asaas cobrava os R$ 419,00 do anual, o sistema aplicava o
 * plano mensal e registrava 30 dias de acesso. O cliente pagava um ANO e perdia o
 * acesso em um MÊS — e a cobrança seguinte só viria doze meses depois, quando ele já
 * estava fora do ar há onze.
 *
 * `externalRef` e a reprogramação ficam com o CHAMADOR (a rota de mudar plano). Não é
 * preciosismo de arquitetura: `asaas.ts` já importa este arquivo, e importar de volta
 * fecharia um ciclo entre os dois módulos.
 */
export interface ResultadoAgendamento {
  valeApartirDe: Date | null;
  /** Periodicidade muda? A tela precisa dizer isso ao cliente com outras palavras. */
  mudaPeriodicidade: boolean;
  planoNovo: { slug: string; name: string; priceCents: number; period: string | null };
}

export async function agendarDowngrade(
  subscriptionId: string,
  novoPlanoId: string,
  ator: { id: string },
): Promise<ResultadoAgendamento> {
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  const novo = await prisma.plan.findUniqueOrThrow({ where: { id: novoPlanoId } });
  const anterior = await prisma.plan.findUnique({ where: { id: sub.planId } });

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { pendingPlanId: novo.id, pendingPlanAt: sub.currentPeriodEnd },
  });

  await logAudit({
    actorId: ator.id,
    action: "subscription.downgrade_scheduled",
    entityType: "Subscription",
    entityId: sub.id,
    metadata: { de: anterior?.slug, para: novo.slug, valeApartirDe: sub.currentPeriodEnd },
  });

  return {
    valeApartirDe: sub.currentPeriodEnd,
    mudaPeriodicidade: (novo.period ?? null) !== (anterior?.period ?? null),
    planoNovo: { slug: novo.slug, name: novo.name, priceCents: novo.priceCents, period: novo.period },
  };
}

export interface ResultadoUpgrade {
  aplicado: boolean;
  creditosAdicionais: number;
  planoAnterior?: string;
  planoNovo: string;
}

/**
 * Aplica o upgrade: troca o plano e soma a diferença de créditos à cota do ciclo.
 *
 * Idempotente pela chave da razão. É obrigatório: quando o upgrade é pago, o Asaas
 * manda DOIS eventos pelo mesmo pagamento (PAYMENT_CONFIRMED e PAYMENT_RECEIVED) e
 * reenvia o webhook quando não recebe 200. Sem a chave, o segundo evento somaria a
 * diferença de créditos outra vez.
 */
export async function aplicarUpgrade(
  subscriptionId: string,
  novoPlanoId: string,
  opcoes: {
    chaveIdempotencia: string;
    motivo: string;
    atorId?: string;
    paymentId?: string | null;
    /**
     * Novo fim de ciclo, quando a troca inicia um período novo.
     *
     * Só é informado na mudança de PERIODICIDADE (mensal → anual): o cliente
     * contratou um ano que começa agora, então o ciclo pago precisa acompanhar.
     * Numa troca de faixa dentro do mesmo período fica ausente, porque o ciclo é o
     * mesmo e mexer nele daria ao cliente tempo que ele não comprou.
     */
    novoCicloAte?: Date | null;
  },
): Promise<ResultadoUpgrade> {
  return prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    const novo = await tx.plan.findUniqueOrThrow({ where: { id: novoPlanoId } });
    const anterior = await tx.plan.findUnique({ where: { id: sub.planId } });

    const jaFeito = await tx.creditLedger.findUnique({ where: { idempotencyKey: opcoes.chaveIdempotencia } });
    if (jaFeito) {
      return { aplicado: false, creditosAdicionais: 0, planoAnterior: anterior?.slug, planoNovo: novo.slug };
    }

    const diferenca = Math.max(0, novo.monthlyAnalyses - (anterior?.monthlyAnalyses ?? 0));
    const saldoAntes = Math.max(0, sub.analysesQuota - sub.analysesUsed) + Math.max(0, sub.extraAnalyses);

    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        planId: novo.id,
        maxUsers: novo.maxUsers,
        amountCents: novo.priceCents,
        // O consumo NÃO é zerado: quem gastou 1 de 2 e sobe para 8 fica com 7.
        ...(diferenca > 0 ? { analysesQuota: { increment: diferenca } } : {}),
        /**
         * Plano novo SEM LIMITE zera a cota, que é como o sistema representa
         * "ilimitado" — e aí o consumo acumulado deixa de fazer sentido, porque
         * não há mais nada a debitar.
         */
        ...(novo.monthlyAnalyses === 0 ? { analysesQuota: 0, analysesUsed: 0 } : {}),
        // Ciclo novo, só quando a periodicidade mudou.
        ...(opcoes.novoCicloAte
          ? { currentPeriodEnd: opcoes.novoCicloAte, nextRenewalAt: opcoes.novoCicloAte }
          : {}),
        // Upgrade cancela downgrade que estivesse agendado.
        pendingPlanId: null,
        pendingPlanAt: null,
      },
    });

    /**
     * A razão registra a entrada mesmo quando a diferença é zero (troca lateral).
     * É ela que carrega a chave de idempotência — sem a linha, um reenvio do
     * webhook aplicaria a troca de novo.
     */
    await tx.creditLedger.create({
      data: {
        subscriptionId: sub.id,
        kind: "ASSINATURA",
        bucket: diferenca > 0 ? "MENSAL" : null,
        quantity: diferenca,
        balanceBefore: saldoAntes,
        balanceAfter: saldoAntes + diferenca,
        description: `Upgrade para ${novo.name}: complemento de cota do ciclo`,
        reason: opcoes.motivo,
        actorId: opcoes.atorId,
        paymentId: opcoes.paymentId ?? null,
        idempotencyKey: opcoes.chaveIdempotencia,
      },
    });

    await logAudit({
      actorId: opcoes.atorId,
      action: "subscription.upgrade",
      entityType: "Subscription",
      entityId: sub.id,
      metadata: { de: anterior?.slug, para: novo.slug, creditosAdicionais: diferenca, motivo: opcoes.motivo },
    });

    return { aplicado: true, creditosAdicionais: diferenca, planoAnterior: anterior?.slug, planoNovo: novo.slug };
  });
}

/**
 * Encerra as assinaturas cujo ciclo pago terminou e que NÃO renovam.
 *
 * ── Por que é necessário ──────────────────────────────────────────────────────
 * O acesso já parava sozinho: `subscriptionAccess` compara `currentPeriodEnd` com
 * a data de hoje. Mas o STATUS continuava `ATIVA` para sempre, e isso mente em
 * todo lugar que soma pelo status — o MRR do painel contava como receita
 * recorrente quem nunca vai pagar de novo, e "Assinantes ativos" incluía contas
 * encerradas há meses.
 *
 * Ficou evidente com o PIX: contratação de ciclo único, sem renovação possível.
 * `nextRenewalAt` nulo é o sinal de "não renova" — ver `ativarAssinatura`.
 * Assinatura de cartão tem data de renovação e NÃO é encerrada aqui: quem decide
 * o fim dela é o gateway, pelo evento de atraso ou cancelamento.
 */
export async function encerrarAssinaturasVencidas(
  agora: Date = new Date(),
): Promise<{ encerradas: number }> {
  const vencidas = await prisma.subscription.findMany({
    where: {
      status: "ATIVA",
      nextRenewalAt: null,
      currentPeriodEnd: { lt: agora },
    },
    select: { id: true, organizationId: true, currentPeriodEnd: true },
  });

  for (const sub of vencidas) {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: "VENCIDA" },
    });
    await logAudit({
      action: "subscription.expired",
      entityType: "Subscription",
      entityId: sub.id,
      metadata: { motivo: "ciclo_unico_sem_renovacao", venceuEm: sub.currentPeriodEnd },
    });
  }

  return { encerradas: vencidas.length };
}

/**
 * Aplica o plano que estava agendado, quando o ciclo pago terminou.
 *
 * Por que existe: `pendingPlanId` era GRAVADO (na troca de plano pelo checkout e
 * agora também por esta tela) e NUNCA era lido. Todo downgrade agendado do
 * sistema era, na prática, um bilhete jogado no lixo: o cliente pedia o plano
 * menor, a tela confirmava "agendado para o fim do período", e na renovação ele
 * continuava sendo cobrado pelo plano caro — indefinidamente. É chamado no momento
 * em que o ciclo novo é pago, que é exatamente quando a troca deve valer.
 *
 * Devolve `aplicado: false` quando não há nada agendado ou a data ainda não
 * chegou, para o chamador seguir com o plano corrente.
 */
export interface ResultadoPlanoAgendado {
  aplicado: boolean;
  planoNovo?: string;
  planoAnterior?: string;
  /**
   * A troca foi ADIADA porque a cobrança que chegou é a do plano antigo — sinal de que
   * a recorrência não foi reprogramada no provedor. Ver a rede de segurança abaixo.
   */
  adiado?: boolean;
  /** Valor que o provedor cobrou, para o chamador poder avisar a operação. */
  valorPagoCents?: number;
  /** Preço esperado do plano que estava agendado. */
  valorEsperadoCents?: number;
}

export async function aplicarPlanoAgendado(
  subscriptionId: string,
  opcoes: {
    agora?: Date;
    /**
     * Quanto o provedor cobrou nesta renovação. É o que permite descobrir que a
     * recorrência ficou no plano antigo — informe sempre que houver pagamento.
     */
    valorPagoCents?: number;
  } = {},
): Promise<ResultadoPlanoAgendado> {
  const agora = opcoes.agora ?? new Date();
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub?.pendingPlanId) return { aplicado: false };

  // Sem data agendada, trata como "na próxima renovação" — que é agora.
  if (sub.pendingPlanAt && sub.pendingPlanAt.getTime() > agora.getTime()) {
    return { aplicado: false };
  }

  const [novo, anterior] = await Promise.all([
    prisma.plan.findUnique({ where: { id: sub.pendingPlanId } }),
    prisma.plan.findUnique({ where: { id: sub.planId } }),
  ]);
  if (!novo) {
    // Plano agendado desapareceu do catálogo: limpa o agendamento em vez de
    // deixar a assinatura presa a um id inválido para sempre.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { pendingPlanId: null, pendingPlanAt: null },
    });
    return { aplicado: false };
  }

  /**
   * ── REDE DE SEGURANÇA: o dinheiro que chegou é de qual plano? ────────────────
   *
   * A reprogramação da recorrência acontece no agendamento, mas pode falhar — o Asaas
   * fora do ar, uma assinatura antiga agendada antes deste conserto existir. Quando
   * falha, a cobrança da renovação chega no valor do plano ANTIGO.
   *
   * Aplicar o downgrade nesse momento produz o pior resultado possível: o cliente paga
   * R$ 419,00 do anual e o sistema registra o período do MENSAL — trinta dias por um ano
   * de dinheiro. Então a troca é ADIADA: o cliente recebe o período que efetivamente
   * pagou, e o downgrade passa a valer no fim dele.
   *
   * O critério não usa constante mágica: compara a distância do valor pago ao preço de
   * cada um dos dois planos. Mais perto do plano antigo significa que foi o antigo que
   * o provedor cobrou. Desconto e promoção não confundem, porque a comparação é relativa.
   */
  const pago = opcoes.valorPagoCents ?? 0;
  if (pago > 0 && anterior && anterior.priceCents !== novo.priceCents) {
    const distanciaAoNovo = Math.abs(pago - novo.priceCents);
    const distanciaAoAntigo = Math.abs(pago - anterior.priceCents);
    if (distanciaAoAntigo < distanciaAoNovo) {
      await logAudit({
        action: "subscription.downgrade_adiado",
        entityType: "Subscription",
        entityId: sub.id,
        metadata: {
          de: anterior.slug,
          para: novo.slug,
          valorPagoCents: pago,
          valorEsperadoCents: novo.priceCents,
          motivo: "a cobrança recebida é a do plano antigo — recorrência não reprogramada no provedor",
        },
      });
      return {
        aplicado: false,
        adiado: true,
        planoNovo: novo.slug,
        planoAnterior: anterior.slug,
        valorPagoCents: pago,
        valorEsperadoCents: novo.priceCents,
      };
    }
  }

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      planId: novo.id,
      amountCents: novo.priceCents,
      maxUsers: novo.maxUsers,
      pendingPlanId: null,
      pendingPlanAt: null,
    },
  });

  await logAudit({
    action: "subscription.downgrade_applied",
    entityType: "Subscription",
    entityId: sub.id,
    metadata: { de: anterior?.slug, para: novo.slug, agendadoPara: sub.pendingPlanAt },
  });

  // A cota do novo ciclo é liberada pelo chamador, DEPOIS desta troca, para sair
  // já com a cota do plano novo.
  return { aplicado: true, planoNovo: novo.slug, planoAnterior: anterior?.slug };
}
