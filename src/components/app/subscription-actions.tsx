"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface Props {
  /** Rótulo do CTA principal de pagamento (assinar/regularizar/reativar). Ausente = não mostra. */
  primaryLabel?: string;
  /** Mostra o botão de cancelar (assinatura ativa). */
  showCancel?: boolean;
}

/**
 * Ações da tela "Minha assinatura".
 *
 * ── O botão principal estava quebrado, e era o botão de comprar ───────────────
 * Ele chamava `GET /api/assinatura/checkout` SEM parâmetro nenhum, e essa rota
 * responde `400 — "Informe o plano ou o pacote desejado"` quando não recebe plano.
 * Ou seja: "Assinar por R$ 49,90", "Regularizar pagamento" e "Reativar assinatura"
 * — os três estados do CTA — falhavam sempre, com uma mensagem de erro genérica. Só
 * comprava quem entrasse pela página de planos.
 *
 * O conserto não é montar a URL aqui com um plano adivinhado. Desde que existem três
 * formas de pagamento, a escolha da FORMA faz parte da compra: cartão e boleto
 * renovam, PIX é pagamento único. Um botão que abre o checkout direto teria de
 * escolher por conta própria, e a escolha silenciosa seria cartão — vendendo
 * renovação a quem talvez não queira. Por isso o CTA leva à página de planos, que é
 * a única tela que apresenta as três formas com a consequência de cada uma.
 */
export function SubscriptionActions({ primaryLabel, showCancel }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function cancel() {
    if (!confirm("Deseja cancelar a assinatura? Você mantém o acesso até o fim do período já pago e não haverá novas cobranças.")) return;
    setErr(null);
    setMsg(null);
    setLoading("cancel");
    try {
      const res = await fetch("/api/assinatura/cancelar", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.data) {
        // A mensagem já vem completa da rota, inclusive quando a interrupção da
        // cobrança no provedor não pôde ser confirmada. Não montar texto aqui:
        // dizer "não haverá novas cobranças" sem que o gateway tenha confirmado
        // é promessa que o sistema pode não cumprir.
        setMsg(data.data.message as string);
        router.refresh();
      } else {
        setErr(data.error ?? "Não foi possível cancelar.");
      }
    } catch {
      setErr("Falha de conexão. Tente novamente.");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {primaryLabel && (
          <Link href="/planos" className="btn-primary text-sm">
            {primaryLabel}
          </Link>
        )}
        {showCancel && (
          <button onClick={cancel} disabled={loading === "cancel"} className="btn-ghost text-sm text-alerta-700">
            {loading === "cancel" ? "Cancelando…" : "Cancelar assinatura"}
          </button>
        )}
      </div>
      {msg && <p className="rounded-lg bg-sucesso-50 px-3 py-2 text-sm text-sucesso">{msg}</p>}
      {err && <p className="rounded-lg bg-alerta-50 px-3 py-2 text-sm text-alerta-700">{err}</p>}
    </div>
  );
}
