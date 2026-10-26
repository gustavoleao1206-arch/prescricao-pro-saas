"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/**
 * Abre o pagamento do plano/pacote escolhido e leva o cliente para lá.
 *
 * Roda no cliente de propósito: cada chamada cria uma sessão de checkout no Asaas,
 * e fazer isso durante o render do servidor geraria cobrança abandonada a cada
 * visita — ou a cada prefetch de link do Next.
 *
 * Erro aqui não é raro nem exótico: a sessão de checkout do Asaas expira em 60
 * minutos, o cliente pode ficar sem internet no meio, o provedor pode recusar. Por
 * isso a falha mostra o motivo e um botão para tentar de novo, em vez de deixar a
 * pessoa numa tela de "carregando" para sempre.
 */
export function IrParaPagamento({
  plano,
  pacote,
  metodo,
}: {
  plano?: string;
  pacote?: string;
  /** "cartao" (recorrente) ou "pix" (ciclo único). Só se aplica a plano. */
  metodo?: "cartao" | "pix";
}) {
  const [erro, setErro] = useState<string | null>(null);
  const [tentando, setTentando] = useState(true);
  // Em desenvolvimento o React monta o componente duas vezes; sem esta trava,
  // seriam duas cobranças criadas no Asaas por visita.
  const jaTentou = useRef(false);

  async function abrir() {
    setErro(null);
    setTentando(true);
    try {
      const qs = plano
        ? `plano=${encodeURIComponent(plano)}&metodo=${metodo ?? "cartao"}`
        : `pacote=${encodeURIComponent(pacote ?? "")}`;
      const res = await fetch(`/api/assinatura/checkout?${qs}`);
      const data = await res.json();
      if (res.ok && data.data?.url) {
        window.location.href = data.data.url;
        return;
      }
      setErro(data.error ?? "Não foi possível abrir o pagamento agora.");
    } catch {
      setErro("Falha de conexão. Verifique sua internet e tente novamente.");
    } finally {
      setTentando(false);
    }
  }

  useEffect(() => {
    if (jaTentou.current) return;
    jaTentou.current = true;
    void abrir();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      {erro ? (
        <div className="card p-8">
          <h1 className="text-xl text-marinho-700">Não foi possível abrir o pagamento</h1>
          <p className="mt-3 text-sm text-alerta-700">{erro}</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <button type="button" onClick={abrir} className="btn-primary text-sm">
              Tentar de novo
            </button>
            <Link href="/assinatura" className="btn-outline text-sm">
              Voltar para minha assinatura
            </Link>
            <Link href="/suporte" className="btn-ghost text-sm">
              Falar com o suporte
            </Link>
          </div>
        </div>
      ) : (
        <div className="card p-8">
          <h1 className="text-xl text-marinho-700">Abrindo o pagamento…</h1>
          <p className="mt-3 text-sm text-neutro-500">
            {tentando
              ? "Estamos gerando sua cobrança em ambiente seguro. Não feche esta página."
              : "Redirecionando…"}
          </p>
        </div>
      )}
    </div>
  );
}
