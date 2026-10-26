/**
 * Marca institucional Leão Amorim.
 *
 * Reproduz a marca como no site oficial: o símbolo (public/logo-leao-amorim.png)
 * é aplicado como MÁSCARA e preenchido com o gradiente da marca
 * (#4F7CFF a #26D5EE), acompanhado de "LEÃO AMORIM" e, abaixo, o nome do
 * produto. A arte e as proporções do símbolo são preservadas.
 *
 * variant="light" para fundos escuros; "dark" (padrão) para fundos claros.
 */

const GRADIENTE_MARCA = "linear-gradient(120deg, #4F7CFF 0%, #26D5EE 100%)";
const SIMBOLO = "url('/logo-leao-amorim.png')";

export function Logo({
  variant = "dark",
  className = "h-10",
}: {
  variant?: "dark" | "light";
  className?: string;
}) {
  const nome = variant === "light" ? "text-white" : "text-marinho-800";
  // Tom do gradiente com melhor contraste em cada fundo.
  const subCor = variant === "light" ? "#3ECFEA" : "#3A63D8";

  return (
    <span className="inline-flex items-center gap-3">
      <span
        aria-hidden
        className={`${className} aspect-square shrink-0 select-none`}
        style={{
          backgroundImage: GRADIENTE_MARCA,
          WebkitMaskImage: SIMBOLO,
          maskImage: SIMBOLO,
          WebkitMaskSize: "contain",
          maskSize: "contain",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskPosition: "center",
        }}
      />
      <span className="leading-tight">
        <span className={`block font-display text-base font-bold uppercase tracking-[0.06em] ${nome}`}>Leão Amorim</span>
        {/* Tracking menor que o antigo "TECNOLOGIA": "PRESCRIÇÃO PRO" é bem mais
            longo e, com o espaçamento anterior, a linha ultrapassava a largura
            do nome acima e quebrava o alinhamento da marca. */}
        <span
          className="mt-0.5 block font-mono text-[9px] font-medium uppercase tracking-[0.18em]"
          style={{ color: subCor }}
        >
          Prescrição Pro
        </span>
      </span>
    </span>
  );
}
