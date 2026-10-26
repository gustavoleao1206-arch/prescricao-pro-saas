"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export function VerifyEmail({ token }: { token?: string }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [message, setMessage] = useState("Verificando…");

  useEffect(() => {
    if (!token) {
      setState("error");
      setMessage("Link de verificação inválido.");
      return;
    }
    (async () => {
      const res = await fetch("/api/auth/verificar-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setState("ok");
        setMessage(data.data?.message ?? "E-mail verificado.");
      } else {
        setState("error");
        setMessage(data.error ?? "Não foi possível verificar o e-mail.");
      }
    })();
  }, [token]);

  return (
    <div className="card p-8 text-center">
      <h1 className="text-2xl">Verificação de e-mail</h1>
      <p className={`mt-4 text-sm ${state === "error" ? "text-alerta-700" : "text-neutro-600"}`}>{message}</p>
      {state === "ok" && <Link href="/login" className="btn-primary mt-6 inline-flex">Entrar</Link>}
      {state === "error" && <Link href="/login" className="btn-outline mt-6 inline-flex">Ir para o login</Link>}
    </div>
  );
}
