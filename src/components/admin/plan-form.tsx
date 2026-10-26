"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Cria/atualiza um plano (por slug), configuração comercial sem editar código. */
export function PlanForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const f = new FormData(e.currentTarget);
    const res = await fetch("/api/admin/planos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: f.get("slug"),
        name: f.get("name"),
        description: f.get("description") || undefined,
        priceCents: Math.round(Number(f.get("price")) * 100),
        period: f.get("period"),
        trialDays: Number(f.get("trialDays") || 0),
        monthlyAnalyses: Number(f.get("monthlyAnalyses") || 0),
        maxUsers: Number(f.get("maxUsers") || 1),
        active: true,
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok && data.ok) {
      setMsg(`Plano salvo (${data.data.slug}).`);
      (e.target as HTMLFormElement).reset();
      router.refresh();
    } else {
      setMsg(data.error ?? "Falha ao salvar.");
    }
  }

  if (!open) return <button onClick={() => setOpen(true)} className="btn-primary">＋ Novo/editar plano</button>;

  return (
    <form onSubmit={onSubmit} className="card space-y-3 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <input name="slug" placeholder="slug (ex.: mensal)" required className="input" />
        <input name="name" placeholder="Nome do plano" required className="input" />
        <input name="price" type="number" step="0.01" placeholder="Preço (R$)" className="input" />
        <select name="period" className="input">
          <option value="MENSAL">Mensal</option>
          <option value="ANUAL">Anual</option>
          <option value="PACOTE">Pacote</option>
          <option value="UNICO">Único</option>
        </select>
        <input name="monthlyAnalyses" type="number" placeholder="Análises (0=ilimitado)" className="input" />
        <input name="maxUsers" type="number" placeholder="Máx. usuários" className="input" />
        <input name="trialDays" type="number" placeholder="Dias de teste" className="input" />
        <input name="description" placeholder="Descrição" className="input" />
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="btn-primary">{busy ? "Salvando…" : "Salvar plano"}</button>
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost">Cancelar</button>
        {msg && <span className="text-sm text-neutro-600">{msg}</span>}
      </div>
    </form>
  );
}
