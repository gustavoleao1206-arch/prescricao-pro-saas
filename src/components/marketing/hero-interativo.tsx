"use client";

import { useEffect, useRef } from "react";
import { ARTE_FUNDO } from "@/components/ui/fundo-interativo";

/**
 * Hero de página cheia com efeito de revelação: a arte institucional aparece
 * sob uma "lanterna" que segue o ponteiro, sobre grade técnica e ruído.
 *
 * Layout inspirado na referência hero05 aprovada pelo dono, adaptado à
 * identidade da marca: base marinho escuro, arte "Tecnologia" no lugar de foto
 * e o gradiente azul→ciano nos acentos. O componente cuida SÓ da camada
 * visual; todo o texto vem de fora (children/aside), para que o conteúdo
 * continue no servidor e nenhuma palavra do site mude por causa do layout.
 *
 * Técnica: em vez do canvas da referência, a máscara é um radial-gradient em
 * CSS atualizado por variáveis (--mx/--my) num requestAnimationFrame com
 * interpolação. Mesmo efeito, GPU faz o trabalho, e a limpeza é um único
 * cancelAnimationFrame. Sem ponteiro fino (celular/tablet) ou com
 * prefers-reduced-motion, a lanterna fica fixa no centro: o visual permanece,
 * o movimento não.
 */
export function HeroInterativo({
  children,
  aside,
}: {
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  const secaoRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const secao = secaoRef.current;
    if (!secao) return;

    // O gate NÃO é decidido na montagem: matchMedia("(pointer: fine)") pode
    // responder errado nesse instante (emulação de dispositivo aplicada tarde,
    // painéis embutidos) e o efeito ficaria morto para sempre. Em vez disso, o
    // filtro é por EVENTO (só ponteiro de mouse/caneta move a lanterna) e por
    // QUADRO (movimento reduzido congela no centro) — sem corrida de montagem.
    const reduzMovimento = window.matchMedia("(prefers-reduced-motion: reduce)");

    const alvo = { x: 0.5, y: 0.45 };
    const suave = { x: 0.5, y: 0.45 };
    let quadro = 0;

    const aoMover = (e: PointerEvent) => {
      // Toque não guia a lanterna: no celular ela fica fixa no centro.
      if (e.pointerType === "touch") return;
      const r = secao.getBoundingClientRect();
      alvo.x = (e.clientX - r.left) / r.width;
      alvo.y = (e.clientY - r.top) / r.height;
    };
    const aoSair = () => {
      alvo.x = 0.5;
      alvo.y = 0.45;
    };

    const animar = () => {
      // Movimento reduzido: congela no centro, checado por quadro (barato) para
      // acompanhar mudanças da preferência sem depender do estado da montagem.
      if (reduzMovimento.matches) {
        alvo.x = 0.5;
        alvo.y = 0.45;
      }
      // Interpolação: a lanterna persegue o ponteiro com atraso, que é o que dá
      // a sensação de peso do efeito original.
      suave.x += (alvo.x - suave.x) * 0.08;
      suave.y += (alvo.y - suave.y) * 0.08;
      secao.style.setProperty("--mx", `${(suave.x * 100).toFixed(2)}%`);
      secao.style.setProperty("--my", `${(suave.y * 100).toFixed(2)}%`);
      // Paralaxe leve da grade, na direção oposta ao ponteiro.
      secao.style.setProperty("--gx", `${((0.5 - suave.x) * 22).toFixed(2)}px`);
      secao.style.setProperty("--gy", `${((0.5 - suave.y) * 22).toFixed(2)}px`);
      quadro = requestAnimationFrame(animar);
    };

    secao.addEventListener("pointermove", aoMover);
    secao.addEventListener("pointerleave", aoSair);
    quadro = requestAnimationFrame(animar);
    return () => {
      secao.removeEventListener("pointermove", aoMover);
      secao.removeEventListener("pointerleave", aoSair);
      cancelAnimationFrame(quadro);
    };
  }, []);

  return (
    <section
      ref={secaoRef}
      aria-label="Apresentação do Prescrição Pro"
      className="relative isolate overflow-hidden bg-[#060a14]"
      style={{ "--mx": "50%", "--my": "45%", "--gx": "0px", "--gy": "0px" } as React.CSSProperties}
    >
      {/* Base: degradê marinho da marca, sempre escuro (identidade). */}
      <div
        aria-hidden
        className="absolute inset-0 -z-30 bg-[radial-gradient(115%_120%_at_15%_0%,#12204a_0%,#0a1228_45%,#060a14_100%)]"
      />

      {/* Arte institucional revelada pela lanterna que segue o ponteiro. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-20 bg-cover bg-center opacity-90"
        style={{
          backgroundImage: `url('${ARTE_FUNDO}')`,
          maskImage: "radial-gradient(circle 340px at var(--mx) var(--my), black 0%, rgba(0,0,0,0.35) 55%, transparent 78%)",
          WebkitMaskImage:
            "radial-gradient(circle 340px at var(--mx) var(--my), black 0%, rgba(0,0,0,0.35) 55%, transparent 78%)",
        }}
      />

      {/* Halo de cor da marca acompanhando a lanterna. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 opacity-70"
        style={{
          background:
            "radial-gradient(circle 420px at var(--mx) var(--my), rgba(79,124,255,0.16) 0%, rgba(38,213,238,0.06) 45%, transparent 75%)",
        }}
      />

      {/* Grade técnica com paralaxe sutil. */}
      <svg
        aria-hidden
        className="absolute -inset-10 -z-10 h-[calc(100%+80px)] w-[calc(100%+80px)] opacity-[0.13]"
        style={{ transform: "translate(var(--gx), var(--gy))" }}
      >
        <defs>
          <pattern id="hero-grade" width="48" height="48" patternUnits="userSpaceOnUse">
            <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#64748b" strokeWidth="0.6" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#hero-grade)" />
      </svg>

      {/* Ruído fino, como na referência: tira o aspecto "chapado" do fundo. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 opacity-[0.35] mix-blend-overlay"
        style={{
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.4) 0.65px, transparent 0.65px), radial-gradient(rgba(0,0,0,0.25) 0.65px, transparent 0.65px)",
          backgroundSize: "3px 3px, 5px 5px",
          backgroundPosition: "0 0, 1px 2px",
        }}
      />

      {/* Vinheta inferior: garante contraste do texto e costura com a seção seguinte. */}
      <div aria-hidden className="absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-b from-transparent to-[#060a14]" />

      <div className="container-page relative">
        <div className="flex min-h-[78vh] flex-col justify-center gap-12 py-20 lg:flex-row lg:items-center lg:gap-16 lg:py-24">
          <div className="max-w-3xl flex-1">{children}</div>
          {aside && (
            <aside
              aria-label="Matérias de análise"
              className="shrink-0 border-white/15 lg:w-64 lg:border-l lg:pl-10"
            >
              {aside}
            </aside>
          )}
        </div>
      </div>
    </section>
  );
}
