import { describe, it, expect } from "vitest";
import { subscriptionGrantsAccess, subscriptionAccess, quotaStatus } from "../src/lib/consumption";
import type { Subscription } from "@prisma/client";

/**
 * Máquina de estados de acesso à assinatura — validação NO SERVIDOR.
 * Cobre a regra comercial: acesso enquanto ATIVA/TESTE no prazo; carência ao
 * cancelar (mantém acesso até o fim do período pago); bloqueio nos demais estados.
 */

const NOW = new Date("2026-07-17T12:00:00Z");
const future = new Date("2026-08-17T12:00:00Z");
const past = new Date("2026-07-10T12:00:00Z");

function sub(partial: Partial<Subscription>): Subscription {
  return {
    id: "s1",
    organizationId: "o1",
    planId: "p1",
    status: "ATIVA",
    provider: "ASAAS",
    externalRef: null,
    amountCents: 3990,
    startedAt: past,
    currentPeriodEnd: future,
    canceledAt: null,
    canceledReason: null,
    suspendedAt: null,
    reactivatedAt: null,
    analysesUsed: 0,
    analysesQuota: 0,
    extraAnalyses: 0,
    createdAt: past,
    updatedAt: past,
    ...partial,
  } as Subscription;
}

describe("Acesso por status da assinatura (gate no servidor)", () => {
  it("concede acesso: ATIVA/TESTE no prazo, sem vencimento e CANCELADA em carência", () => {
    expect(subscriptionGrantsAccess(sub({ status: "ATIVA", currentPeriodEnd: future }), NOW)).toBe(true);
    expect(subscriptionGrantsAccess(sub({ status: "TESTE", currentPeriodEnd: future }), NOW)).toBe(true);
    expect(subscriptionGrantsAccess(sub({ status: "ATIVA", currentPeriodEnd: null }), NOW)).toBe(true);
    // Política de cancelamento: mantém acesso até o fim do período já pago.
    expect(subscriptionGrantsAccess(sub({ status: "CANCELADA", currentPeriodEnd: future }), NOW)).toBe(true);
  });

  it("bloqueia: sem assinatura, vencida, inadimplente, suspensa, cancelada esgotada, estornada", () => {
    expect(subscriptionGrantsAccess(null, NOW)).toBe(false);
    expect(subscriptionGrantsAccess(sub({ status: "ATIVA", currentPeriodEnd: past }), NOW)).toBe(false);
    expect(subscriptionGrantsAccess(sub({ status: "INADIMPLENTE", currentPeriodEnd: past }), NOW)).toBe(false);
    expect(subscriptionGrantsAccess(sub({ status: "SUSPENSA", currentPeriodEnd: past }), NOW)).toBe(false);
    expect(subscriptionGrantsAccess(sub({ status: "CANCELADA", currentPeriodEnd: past }), NOW)).toBe(false);
    expect(subscriptionGrantsAccess(sub({ status: "VENCIDA", currentPeriodEnd: past }), NOW)).toBe(false);
    expect(subscriptionGrantsAccess(sub({ status: "ESTORNADA", currentPeriodEnd: past }), NOW)).toBe(false);
  });

  it("subscriptionAccess: motivo e ação sugerida por estado", () => {
    expect(subscriptionAccess(null, NOW)).toMatchObject({ hasAccess: false, reason: "sem_assinatura", action: "assinar" });
    expect(subscriptionAccess(sub({ status: "ATIVA", currentPeriodEnd: future }), NOW)).toMatchObject({ hasAccess: true, reason: "ok" });
    expect(subscriptionAccess(sub({ status: "CANCELADA", currentPeriodEnd: future }), NOW)).toMatchObject({ hasAccess: true, reason: "carencia_cancelada", inGracePeriod: true });
    expect(subscriptionAccess(sub({ status: "INADIMPLENTE", currentPeriodEnd: past }), NOW)).toMatchObject({ hasAccess: false, reason: "inadimplente", action: "regularizar" });
    expect(subscriptionAccess(sub({ status: "SUSPENSA", currentPeriodEnd: past }), NOW)).toMatchObject({ hasAccess: false, reason: "suspensa", action: "regularizar" });
    expect(subscriptionAccess(sub({ status: "ESTORNADA", currentPeriodEnd: past }), NOW)).toMatchObject({ hasAccess: false, reason: "estornada", action: "suporte" });
  });
});

describe("Cota do plano (ilimitado vs limitado)", () => {
  it("plano ilimitado (quota 0) sempre permite", () => {
    const q = quotaStatus(sub({ analysesQuota: 0, analysesUsed: 999 }));
    expect(q.unlimited).toBe(true);
    expect(q.allowed).toBe(true);
  });

  it("plano limitado respeita a cota (incluindo análises extras)", () => {
    expect(quotaStatus(sub({ analysesQuota: 3, analysesUsed: 2 })).allowed).toBe(true);
    expect(quotaStatus(sub({ analysesQuota: 3, analysesUsed: 3 })).allowed).toBe(false);
    expect(quotaStatus(sub({ analysesQuota: 3, analysesUsed: 3, extraAnalyses: 5 })).allowed).toBe(true);
  });

  it("sem assinatura não permite consumo", () => {
    expect(quotaStatus(null).allowed).toBe(false);
  });
});
