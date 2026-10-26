"use client";

import { useEffect, useRef } from "react";

/**
 * Caminho da arte institucional de fundo, num lugar só — o fundo global e o
 * hero da home leem daqui.
 *
 * A arte atual é o relógio em espiral na nebulosa, arte própria do
 * produto, o que dispensa licença de banco de imagens.
 */
export const ARTE_FUNDO = "/fundo-relogio.jpg";

/**
 * Fundo interativo GLOBAL: substitui a camada fixa estática que ficava atrás
 * de todas as páginas. A arte continua a mesma, no mesmo plano (-z), atrás dos
 * véus de cada seção; o que muda é que agora uma "lanterna" clareia a arte
 * seguindo o ponteiro, com halo na cor da marca e grade técnica em paralaxe.
 *
 * Intensidade por tema, de propósito: no escuro os véus deixam ~10-30% da
 * camada passar e o efeito aparece bem; no claro os véus são quase opacos
 * (0,965/0,99) para preservar a nitidez de leitura que o dono exigiu — ali o
 * efeito fica sutil por consequência, e é assim que deve ser: interatividade
 * não pode custar contraste de texto corrido.
 *
 * Mesmas regras de robustez do hero: filtro de ponteiro por EVENTO (toque não
 * guia) e movimento reduzido por QUADRO, nunca decidido na montagem.
 */
export function FundoInterativo() {
  const raiz = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = raiz.current;
    if (!el) return;

    const reduzMovimento = window.matchMedia("(prefers-reduced-motion: reduce)");
    const alvo = { x: 0.5, y: 0.4 };
    const suave = { x: 0.5, y: 0.4 };
    let quadro = 0;

    const aoMover = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      alvo.x = e.clientX / window.innerWidth;
      alvo.y = e.clientY / window.innerHeight;
    };

    const animar = () => {
      if (reduzMovimento.matches) {
        alvo.x = 0.5;
        alvo.y = 0.4;
      }
      suave.x += (alvo.x - suave.x) * 0.07;
      suave.y += (alvo.y - suave.y) * 0.07;
      el.style.setProperty("--fx", `${(suave.x * 100).toFixed(2)}%`);
      el.style.setProperty("--fy", `${(suave.y * 100).toFixed(2)}%`);
      // --fgx/--fgy existiam só para a paralaxe da grade, que saiu: calcular a
      // cada quadro variável que ninguém lê é trabalho jogado fora.
      quadro = requestAnimationFrame(animar);
    };

    // O ouvinte fica na janela: o fundo é global e o cursor deve guiar a
    // lanterna em qualquer página, sem depender de qual seção está por cima.
    window.addEventListener("pointermove", aoMover, { passive: true });
    quadro = requestAnimationFrame(animar);
    return () => {
      window.removeEventListener("pointermove", aoMover);
      cancelAnimationFrame(quadro);
    };
  }, []);

  return (
    <div
      ref={raiz}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10"
      style={{ "--fx": "50%", "--fy": "40%" } as React.CSSProperties}
    >
      {/* Arte base, como era na camada estática. */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url('${ARTE_FUNDO}')` }}
      />

      {/* Lanterna: a mesma arte, mais clara, revelada ao redor do ponteiro. */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{
          backgroundImage: `url('${ARTE_FUNDO}')`,
          filter: "brightness(1.65) saturate(1.15)",
          maskImage:
            "radial-gradient(circle 380px at var(--fx) var(--fy), black 0%, rgba(0,0,0,0.35) 55%, transparent 80%)",
          WebkitMaskImage:
            "radial-gradient(circle 380px at var(--fx) var(--fy), black 0%, rgba(0,0,0,0.35) 55%, transparent 80%)",
        }}
      />

      {/* Halo da marca acompanhando a lanterna. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle 460px at var(--fx) var(--fy), rgba(79,124,255,0.20) 0%, rgba(38,213,238,0.08) 45%, transparent 75%)",
        }}
      />

      {/*
        A grade técnica saiu daqui a pedido do dono. Ela era uma malha de 48px em
        SVG, a 10% de opacidade, com paralaxe leve — atrás de TODAS as páginas.
        Com o mapa da jornada de fundo transparente, ela passou a aparecer por
        cima do relógio da marca, que é o que se quer ver. Para trazê-la de volta,
        é um <svg> com <pattern> nesta camada; o histórico deste arquivo tem o
        traçado exato.
      */}
    </div>
  );
}
