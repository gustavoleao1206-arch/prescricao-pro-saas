import { prisma } from "./db";
import type { Subscription, SubscriptionStatus } from "@prisma/client";

/**
 * Controle de consumo e limites do plano (transparente e auditável).
 * Cada análise concluída registra um ConsumptionRecord e incrementa analysesUsed.
 * Cota efetiva = analysesQuota + extraAnalyses − analysesUsed (0 = ilimitado).
 */

/** Assinatura mais recente da organização, QUALQUER status (para exibição/decisão de acesso). */
export async function getCurrentSubscription(organizationId: string): Promise<Subscription | null> {
  return prisma.subscription.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Regra central de acesso ao agente (validada no servidor).
 * Concede acesso quando:
 *  - ATIVA ou TESTE e dentro do período (currentPeriodEnd no futuro ou ausente); ou
 *  - CANCELADA porém ainda dentro do período já pago (política: mantém até o fim).
 */
export function subscriptionGrantsAccess(sub: Subscription | null, now: Date = new Date()): boolean {
  if (!sub) return false;
  const notExpired = !sub.currentPeriodEnd || sub.currentPeriodEnd >= now;
  if ((sub.status === "ATIVA" || sub.status === "TESTE") && notExpired) return true;
  if (sub.status === "CANCELADA" && sub.currentPeriodEnd != null && sub.currentPeriodEnd >= now) return true;
  // Inadimplência dentro da tolerância: cartão recusado por limite momentâneo é
  // comum, e cortar o acesso no mesmo dia castiga quem regulariza em 48 horas.
  if (sub.status === "INADIMPLENTE" && sub.graceUntil != null && sub.graceUntil >= now) return true;
  return false;
}

/**
 * Assinatura que CONCEDE acesso agora (ATIVA/TESTE no prazo, ou cancelada em período
 * de carência). Retorna null se a assinatura existir mas não conceder acesso.
 * Mantém compatibilidade com o uso anterior em getAppContext.
 */
export async function getActiveSubscription(organizationId: string): Promise<Subscription | null> {
  const sub = await getCurrentSubscription(organizationId);
  return subscriptionGrantsAccess(sub) ? sub : null;
}

export type AccessReason =
  | "ok"
  | "carencia_cancelada"
  | "tolerancia_inadimplencia"
  | "sem_assinatura"
  | "pendente"
  | "inadimplente"
  | "suspensa"
  | "cancelada"
  | "vencida"
  | "estornada";

export interface SubscriptionAccess {
  hasAccess: boolean;
  status: SubscriptionStatus | null;
  reason: AccessReason;
  message: string;
  /** Ação sugerida ao cliente para restabelecer o acesso, quando aplicável. */
  action: "assinar" | "regularizar" | "reativar" | "suporte" | null;
  currentPeriodEnd: Date | null;
  inGracePeriod: boolean;
}

/** Decisão de acesso + mensagem clara por estado (usada no gate e na interface). */
export function subscriptionAccess(sub: Subscription | null, now: Date = new Date()): SubscriptionAccess {
  if (!sub) {
    return { hasAccess: false, status: null, reason: "sem_assinatura", action: "assinar", currentPeriodEnd: null, inGracePeriod: false, message: "Assinatura ativa necessária para usar o agente." };
  }
  const notExpired = !sub.currentPeriodEnd || sub.currentPeriodEnd >= now;
  const base = { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd };

  if ((sub.status === "ATIVA" || sub.status === "TESTE") && notExpired) {
    return { ...base, hasAccess: true, reason: "ok", action: null, inGracePeriod: false, message: "Assinatura ativa." };
  }
  if (sub.status === "CANCELADA" && sub.currentPeriodEnd != null && sub.currentPeriodEnd >= now) {
    return { ...base, hasAccess: true, reason: "carencia_cancelada", action: "reativar", inGracePeriod: true, message: "Assinatura cancelada. O acesso é mantido até o fim do período já pago." };
  }
  if (sub.status === "INADIMPLENTE" && sub.graceUntil != null && sub.graceUntil >= now) {
    const prazo = sub.graceUntil.toLocaleDateString("pt-BR");
    return {
      ...base,
      hasAccess: true,
      reason: "tolerancia_inadimplencia",
      action: "regularizar",
      inGracePeriod: true,
      message: `Identificamos uma pendência no pagamento da sua assinatura. Regularize até ${prazo} para continuar realizando novas análises.`,
    };
  }

  const detail: Record<SubscriptionStatus, { reason: AccessReason; action: SubscriptionAccess["action"]; message: string }> = {
    ATIVA: { reason: "vencida", action: "regularizar", message: "Assinatura vencida. Renove para continuar usando o agente." },
    TESTE: { reason: "vencida", action: "assinar", message: "Período de teste encerrado. Assine para continuar." },
    INADIMPLENTE: { reason: "inadimplente", action: "regularizar", message: "Pagamento em atraso. Regularize para continuar usando o agente." },
    SUSPENSA: { reason: "suspensa", action: "regularizar", message: "Assinatura suspensa por falta de pagamento. Regularize para reativar o acesso." },
    CANCELADA: { reason: "cancelada", action: "reativar", message: "Assinatura cancelada. Reative para voltar a usar o agente." },
    VENCIDA: { reason: "vencida", action: "reativar", message: "Assinatura vencida. Reative para continuar." },
    ESTORNADA: { reason: "estornada", action: "suporte", message: "Assinatura encerrada por estorno. Fale com o suporte para regularizar." },
  };
  const d = detail[sub.status];
  return { ...base, hasAccess: false, reason: d.reason, action: d.action, inGracePeriod: false, message: d.message };
}

export interface QuotaStatus {
  unlimited: boolean;
  quota: number;
  used: number;
  extra: number;
  remaining: number;
  allowed: boolean;
}

export function quotaStatus(sub: Subscription | null): QuotaStatus {
  if (!sub) {
    return { unlimited: false, quota: 0, used: 0, extra: 0, remaining: 0, allowed: false };
  }
  const unlimited = sub.analysesQuota === 0;
  const total = sub.analysesQuota + sub.extraAnalyses;
  const remaining = unlimited ? Number.POSITIVE_INFINITY : Math.max(0, total - sub.analysesUsed);
  return {
    unlimited,
    quota: sub.analysesQuota,
    used: sub.analysesUsed,
    extra: sub.extraAnalyses,
    remaining: unlimited ? Number.POSITIVE_INFINITY : remaining,
    allowed: unlimited || remaining > 0,
  };
}

/**
 * Registra o consumo de uma análise (idempotente por análise).
 *
 * APENAS telemetria (ConsumptionRecord com os tokens): o débito do saldo é
 * responsabilidade exclusiva do motor de créditos (consumirCreditos, em
 * credits.ts). Este registro JÁ incrementou `analysesUsed` no passado, e a
 * combinação com o motor novo cobrava o contador DUAS vezes por análise — o
 * cliente via 1 crédito no extrato e perdia 2 do saldo. O incremento foi
 * removido daqui; se voltar, o teste de regressão em tests/creditos.test.ts
 * quebra.
 */
export async function recordAnalysisConsumption(
  subscriptionId: string,
  analysisId: string,
  usage?: { input?: number; output?: number },
): Promise<void> {
  const already = await prisma.consumptionRecord.findFirst({
    where: { subscriptionId, analysisId, kind: "analise" },
  });
  if (already) return;

  await prisma.consumptionRecord.create({
    data: {
      subscriptionId,
      analysisId,
      kind: "analise",
      quantity: 1,
      aiInputTokens: usage?.input,
      aiOutputTokens: usage?.output,
    },
  });
}
