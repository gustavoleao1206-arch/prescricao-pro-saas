"use client";

import { useState } from "react";

/**
 * Botão de compra de créditos avulsos. Abre o checkout da oferta; o crédito só
 * entra na conta depois que o pagamento é confirmado pelo webhook, nunca no
 * clique. É o que impede creditar quem abriu o checkout e não pagou.
 */
export function BuyCreditPack({ slug, className }: { slug: string; className?: string }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function comprar() {
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/assinatura/checkout?pacote=${encodeURIComponent(slug)}`);
      const data = await res.json();
      if (res.ok && data.data?.url) {
        window.location.href = data.data.url;
        return;
      }
      setErr(data.error ?? "Não foi possível abrir o checkout de créditos.");
    } catch {
      setErr("Falha de conexão. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={comprar} disabled={loading} className={className}>
        {loading ? "Abrindo…" : "Comprar"}
      </button>
      {err && <p className="rounded-lg bg-alerta-50 px-3 py-2 text-xs text-alerta-700">{err}</p>}
    </div>
  );
}
