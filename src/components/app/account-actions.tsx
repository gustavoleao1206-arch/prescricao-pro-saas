"use client";

import { useState } from "react";

export function AccountActions({ email }: { email: string }) {
  const [msg, setMsg] = useState<string | null>(null);

  async function changePassword() {
    setMsg(null);
    await fetch("/api/auth/recuperar-senha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setMsg("Enviamos um link de redefinição de senha para o seu e-mail.");
  }

  async function requestDeletion() {
    if (!confirm("Deseja solicitar a exclusão dos seus dados? O pedido será processado conforme a política de retenção.")) return;
    const res = await fetch("/api/conta/exclusao", { method: "POST" });
    const data = await res.json();
    setMsg(data.data?.message ?? "Solicitação registrada.");
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button onClick={changePassword} className="btn-outline text-sm">Alterar senha</button>
        <a href="/api/conta/exportar" className="btn-outline text-sm">Exportar meus dados</a>
        <button onClick={requestDeletion} className="btn-ghost text-sm text-alerta-700">Solicitar exclusão</button>
      </div>
      {msg && <p className="text-sm text-sucesso">{msg}</p>}
    </div>
  );
}
