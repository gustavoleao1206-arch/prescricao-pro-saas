"use client";

import { useEffect, useState } from "react";

/**
 * Botão de alternância de tema (claro / escuro).
 *
 * O tema é aplicado pela classe `dark` no <html> e persistido em localStorage.
 * A escolha inicial é resolvida por um script inline no layout raiz (antes da
 * primeira pintura), evitando piscar o tema errado ao carregar a página.
 */
const CHAVE = "ptp-tema";

/** Cores padrão (superfícies claras). Barras escuras passam o seu próprio className. */
const CORES_PADRAO = "border-neutro-200 text-neutro-700";

export function ThemeToggle({ className = CORES_PADRAO }: { className?: string }) {
  const [escuro, setEscuro] = useState<boolean | null>(null);

  // Sincroniza com o estado já aplicado pelo script inline.
  useEffect(() => {
    setEscuro(document.documentElement.classList.contains("dark"));
  }, []);

  function aplicar(modoEscuro: boolean) {
    document.documentElement.classList.toggle("dark", modoEscuro);
    try {
      localStorage.setItem(CHAVE, modoEscuro ? "escuro" : "claro");
    } catch {
      // localStorage indisponível (modo privativo), tema vale só nesta sessão.
    }
    setEscuro(modoEscuro);
  }

  const botao = "inline-flex h-7 w-7 items-center justify-center rounded-lg transition";
  const ativo = "grad-marca text-[#04122E]";
  const inativo = "opacity-55 hover:opacity-100";

  return (
    <div
      role="group"
      aria-label="Tema da página"
      className={`inline-flex shrink-0 items-center gap-1 rounded-xl border p-1 ${className}`}
    >
      <button
        type="button"
        onClick={() => aplicar(false)}
        aria-pressed={escuro === false}
        aria-label="Tema claro"
        title="Clarear"
        className={`${botao} ${escuro === false ? ativo : inativo}`}
      >
        <Sol />
      </button>
      <button
        type="button"
        onClick={() => aplicar(true)}
        aria-pressed={escuro === true}
        aria-label="Tema escuro"
        title="Escurecer"
        className={`${botao} ${escuro === true ? ativo : inativo}`}
      >
        <Lua />
      </button>
    </div>
  );
}

function Sol() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function Lua() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
