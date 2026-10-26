"use client";

import { useState } from "react";

export function ContactForm() {
  const [status, setStatus] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("sending");
    const form = new FormData(e.currentTarget);
    const body = Object.fromEntries(form.entries());
    try {
      const res = await fetch("/api/contato", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setStatus("ok");
        // Sem protocolo na resposta, a frase termina no envio: exibir um
        // marcador vazio depois de "Protocolo:" só confunde quem leu.
        const protocolo: unknown = data.data?.protocolo;
        setMessage(protocolo ? `Mensagem enviada. Protocolo: ${String(protocolo)}` : "Mensagem enviada.");
        e.currentTarget.reset();
      } else {
        setStatus("error");
        setMessage(data.error ?? "Não foi possível enviar. Tente novamente.");
      }
    } catch {
      setStatus("error");
      setMessage("Falha de conexão. Tente novamente.");
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-6">
      <div>
        <label className="label" htmlFor="name">Nome</label>
        <input id="name" name="name" required className="input" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="email">E-mail</label>
          <input id="email" name="email" type="email" required className="input" />
        </div>
        <div>
          <label className="label" htmlFor="phone">Telefone (opcional)</label>
          <input id="phone" name="phone" className="input" />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="message">Mensagem</label>
        <textarea id="message" name="message" required rows={5} className="input" />
      </div>
      <button type="submit" disabled={status === "sending"} className="btn-primary">
        {status === "sending" ? "Enviando…" : "Enviar mensagem"}
      </button>
      {status === "ok" && <p className="text-sm text-sucesso">{message}</p>}
      {status === "error" && <p className="text-sm text-alerta-700">{message}</p>}
    </form>
  );
}
