import { NextRequest, NextResponse } from "next/server";
import { verifyAsaasToken, processAsaasEvent } from "@/lib/asaas";
import { logSecurityEvent } from "@/lib/audit";
import { tratarFalhaDeWebhook } from "@/lib/webhook-falha";
import { clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook do Asaas.
 * - Valida o token enviado no header 'asaas-access-token' (definido ao criar o
 *   webhook no painel do Asaas e guardado em ASAAS_WEBHOOK_TOKEN).
 * - Idempotência garantida em processAsaasEvent (dedup de Payment por externalId
 *   e liberação de créditos idempotente pela chave do ciclo).
 * - Retorna 200 para eventos processados/ignorados (evita reenvios em loop).
 *
 * ── Por que o 500 deixou de ser automático ────────────────────────────────────
 * Erro inesperado devolvia 500 para o Asaas reenviar. A intenção estava certa —
 * pagamento não pode ser perdido por falha momentânea —, mas o Asaas não trata a fila
 * como entregas independentes: ela é INTERROMPIDA no evento que falha, e nenhum evento
 * posterior é entregue enquanto aquele não passar.
 *
 * Um único evento que falha SEMPRE (chave duplicada, plano apagado, dado inconsistente)
 * parava a entrada de TODOS os pagamentos seguintes. O sintoma do nosso lado é "parou de
 * chegar pagamento", sem nada apontando para a causa. Quem decide entre reenviar e
 * dispensar agora é `tratarFalhaDeWebhook`, e dispensar sempre vem com alerta.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const token = req.headers.get("asaas-access-token");

  if (!verifyAsaasToken(token)) {
    await logSecurityEvent({ type: "webhook_invalid", ip, metadata: { source: "asaas", reason: "token" } });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  try {
    const result = await processAsaasEvent(payload as Record<string, unknown>);
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (err) {
    console.error("[asaas] erro ao processar webhook:", (err as Error).message);
    const decisao = await tratarFalhaDeWebhook("asaas", (payload ?? {}) as Record<string, unknown>, err);
    /**
     * 500 pede reenvio e, no Asaas, PARA a fila até o evento passar. 200 dispensa este
     * evento e deixa os pagamentos seguintes entrarem — o caso dispensado já saiu em
     * alerta com o corpo inteiro, então ele não desaparece, só sai do caminho.
     */
    return NextResponse.json(
      { ok: false, error: "processing_error", reenviar: decisao.reenviar, tentativas: decisao.tentativas },
      { status: decisao.reenviar ? 500 : 200 },
    );
  }
}
