"use client";

import { useState } from "react";

/** Alteração de senha inline (exige a senha atual), chama /api/conta/senha. */
export function ChangePasswordForm() {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    const form = e.currentTarget;
    const f = new FormData(form);
    const currentPassword = String(f.get("currentPassword"));
    const newPassword = String(f.get("newPassword"));
    const confirm = String(f.get("confirm"));
    if (newPassword !== confirm) {
      setErr("A confirmação não coincide com a nova senha.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/conta/senha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setMsg("Senha alterada com sucesso.");
        form.reset();
      } else {
        setErr(data.error ?? "Não foi possível alterar a senha.");
      }
    } catch {
      setErr("Falha de conexão. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-md space-y-3">
      <div>
        <label className="label" htmlFor="currentPassword">Senha atual</label>
        <input id="currentPassword" name="currentPassword" type="password" required className="input" autoComplete="current-password" />
      </div>
      <div>
        <label className="label" htmlFor="newPassword">Nova senha</label>
        <input id="newPassword" name="newPassword" type="password" required minLength={10} className="input" autoComplete="new-password" />
      </div>
      <div>
        <label className="label" htmlFor="confirm">Confirmar nova senha</label>
        <input id="confirm" name="confirm" type="password" required minLength={10} className="input" autoComplete="new-password" />
      </div>
      {err && <p className="rounded-lg bg-alerta-50 px-3 py-2 text-sm text-alerta-700">{err}</p>}
      {msg && <p className="rounded-lg bg-sucesso-50 px-3 py-2 text-sm text-sucesso">{msg}</p>}
      <button type="submit" disabled={loading} className="btn-primary text-sm">{loading ? "Salvando…" : "Alterar senha"}</button>
    </form>
  );
}
