"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SupportForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const f = new FormData(e.currentTarget);
    const res = await fetch("/api/suporte", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: f.get("subject"),
        category: f.get("category"),
        priority: f.get("priority"),
        message: f.get("message"),
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok && data.ok) {
      setMsg(`Chamado #${data.data.number} aberto.`);
      (e.target as HTMLFormElement).reset();
      router.refresh();
    } else {
      setMsg(data.error ?? "Falha ao abrir chamado.");
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-6">
      <h2 className="text-lg">Abrir chamado</h2>
      <div>
        <label className="label" htmlFor="subject">Assunto</label>
        <input id="subject" name="subject" required className="input" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="category">Categoria</label>
          <select id="category" name="category" className="input">
            <option value="tecnico">Técnico</option>
            <option value="documentos">Documentos</option>
            <option value="pagamento">Pagamento</option>
            <option value="juridico">Jurídico-operacional</option>
            <option value="outro">Outro</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="priority">Prioridade</label>
          <select id="priority" name="priority" className="input">
            <option value="BAIXA">Baixa</option>
            <option value="MEDIA">Média</option>
            <option value="ALTA">Alta</option>
            <option value="URGENTE">Urgente</option>
          </select>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="message">Mensagem</label>
        <textarea id="message" name="message" required rows={4} className="input" />
      </div>
      <button type="submit" disabled={busy} className="btn-primary">{busy ? "Enviando…" : "Abrir chamado"}</button>
      {msg && <p className="text-sm text-sucesso">{msg}</p>}
    </form>
  );
}
