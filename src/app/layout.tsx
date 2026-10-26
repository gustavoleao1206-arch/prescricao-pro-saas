import type { Metadata } from "next";
import localFont from "next/font/local";
import { FundoInterativo } from "@/components/ui/fundo-interativo";
import "./globals.css";
import { SCRIPT_DO_TEMA } from "@/lib/tema-inicial";

/**
 * Tipografia da marca Leão Amorim Tecnologia — mesmas famílias do site oficial.
 * Fontes AUTO-HOSPEDADAS (arquivos em ./fonts): sem dependência de rede nem no
 * build nem em runtime. Todas sob licença SIL Open Font License (OFL).
 *  - Inter          → corpo de texto
 *  - Space Grotesk  → títulos, botões e a marca
 *  - JetBrains Mono → rótulos maiúsculos espaçados
 */
const fontBody = localFont({
  src: "./fonts/Inter.woff2",
  variable: "--font-body",
  weight: "400 700",
  display: "swap",
});
const fontDisplay = localFont({
  src: "./fonts/SpaceGrotesk.woff2",
  variable: "--font-display",
  weight: "400 700",
  display: "swap",
});
const fontMono = localFont({
  src: "./fonts/JetBrainsMono.woff2",
  variable: "--font-mono",
  weight: "400 600",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Prescrição Pro",
    template: "%s · Prescrição Pro",
  },
  description:
    "Plataforma de apoio jurídico para análise de prescrição e decadência tributária em execuções fiscais, com inteligência artificial.",
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${fontBody.variable} ${fontDisplay.variable} ${fontMono.variable}`}>
      <body>
        {/*
          Aplica o tema salvo (ou a preferência do sistema) antes de pintar a
          página — evita o "flash" do tema errado no carregamento.
        */}
        {/*
          ⚠️ O texto vem de `SCRIPT_DO_TEMA`, e não escrito aqui.

          A Content-Security-Policy autoriza este script pela IMPRESSÃO DIGITAL do conteúdo (as páginas
          públicas são estáticas e não podem usar nonce). Impressão digital só bate se o texto existir em um
          lugar só — escrevê-lo aqui de novo faria o navegador bloqueá-lo em silêncio, e o tema voltaria a
          piscar. Ver src/lib/tema-inicial.ts.
        */}
        <script dangerouslySetInnerHTML={{ __html: SCRIPT_DO_TEMA }} />
        {/* Fundo institucional INTERATIVO, atrás de todo o conteúdo: a lanterna
            segue o ponteiro em todas as páginas, sob os véus de cada seção. */}
        <FundoInterativo />
        {children}
      </body>
    </html>
  );
}
