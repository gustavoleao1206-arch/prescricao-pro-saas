"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Confirmação da troca de e-mail, aberta pelo link que chega no endereço NOVO.
 *
 * Fica na área pública de propósito: o link é aberto na caixa do endereço novo, muitas vezes no
 * celular e sem sessão. Exigir login aqui empurraria o cliente a uma entrada que ele talvez não
 * consiga fazer — e o e-mail antigo, que é o login dele, pode ser justamente o que está errado.
 */
export function ConfirmarTrocaEmail({ token }: { token?: string }) {
  const [estado, setEstado] = useState<"carregando" | "ok" | "erro">("carregando");
  const [mensagem, setMensagem] = useState("Confirmando…");

  useEffect(() => {
    if (!token) {
      setEstado("erro");
      setMensagem("Link de confirmação inválido.");
      return;
    }
    void (async () => {
      try {
        const res = await fetch("/api/conta/email/confirmar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const dados = await res.json();
        if (res.ok && dados.ok) {
          setEstado("ok");
          setMensagem(dados.data?.message ?? "E-mail alterado.");
        } else {
          setEstado("erro");
          setMensagem(dados.error ?? "Não foi possível confirmar a troca.");
        }
      } catch {
        setEstado("erro");
        setMensagem("Não foi possível confirmar a troca agora. Tente abrir o link novamente.");
      }
    })();
  }, [token]);

  return (
    <div className="card p-8 text-center">
      <h1 className="text-2xl">Troca de e-mail</h1>
      <p className={`mt-4 text-sm ${estado === "erro" ? "text-alerta-700" : "text-neutro-600"}`}>{mensagem}</p>
      {estado === "ok" && (
        <>
          {/**
           * O aviso do login novo importa: a pessoa acabou de trocar o endereço que ELA USA PARA
           * ENTRAR. Sem dizer isso, ela tentaria entrar com o antigo e concluiria que perdeu a
           * conta — exatamente no momento em que acabou de consertá-la.
           */}
          <p className="mt-3 text-sm text-neutro-600">
            A partir de agora, entre usando este novo endereço. Sua senha continua a mesma.
          </p>
          <Link href="/login" className="btn-primary mt-6 inline-flex">
            Entrar
          </Link>
        </>
      )}
      {estado === "erro" && (
        <Link href="/login" className="btn-outline mt-6 inline-flex">
          Ir para o login
        </Link>
      )}
    </div>
  );
}
