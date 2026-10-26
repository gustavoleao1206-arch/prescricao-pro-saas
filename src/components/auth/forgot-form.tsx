"use client";

import { useState } from "react";
import Link from "next/link";

export function ForgotForm() {
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const f = new FormData(e.currentTarget);
    await fetch("/api/auth/recuperar-senha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: f.get("email") }),
    });
    setLoading(false);
    setDone(true);
  }

  return (
    <div className="card p-8">
      <h1 className="text-2xl">Recuperar senha</h1>
      {done ? (
        <p className="mt-4 rounded-lg bg-sucesso-50 px-3 py-3 text-sm text-sucesso">
          Se o e-mail existir em nossa base, enviaremos um link para redefinição. Verifique sua caixa de entrada.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div>
            <label className="label" htmlFor="email">E-mail cadastrado</label>
            <input id="email" name="email" type="email" required className="input" />
          </div>
          <button type="submit" disabled={loading} className="btn-primary w-full">{loading ? "Enviando…" : "Enviar link"}</button>
        </form>
      )}
      <p className="mt-6 text-center text-sm text-neutro-500">
        <Link href="/login" className="font-medium text-marinho-600 hover:underline">Voltar ao login</Link>
      </p>
    </div>
  );
}
