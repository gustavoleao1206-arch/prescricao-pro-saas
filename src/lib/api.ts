import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "./auth";

/** Helpers para rotas de API — respostas padronizadas e tratamento de erros. */

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status });
}

/**
 * Erro de assinatura inativa/insuficiente (HTTP 402). Lançado pelo gate central
 * assertActiveSubscription(); convertido em resposta padronizada por route().
 */
export class SubscriptionError extends Error {
  readonly status = 402;
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "SubscriptionError";
    this.reason = reason;
  }
}

/**
 * Envolve um handler de rota, convertendo erros conhecidos em respostas HTTP.
 * Nunca expõe stack traces ou detalhes sensíveis ao cliente.
 */
export function route<T extends unknown[]>(fn: (...args: T) => Promise<Response>) {
  return async (...args: T): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof AuthError) return fail(err.message, err.status);
      if (err instanceof SubscriptionError) return fail(err.message, err.status, { reason: err.reason });
      if (err instanceof ZodError) {
        return fail("Dados inválidos.", 422, { issues: err.flatten().fieldErrors });
      }
      console.error("[api] erro não tratado:", (err as Error).message);
      return fail("Erro interno. Tente novamente.", 500);
    }
  };
}
