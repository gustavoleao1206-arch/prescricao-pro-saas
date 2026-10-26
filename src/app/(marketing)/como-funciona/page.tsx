import Link from "next/link";
import type { Metadata } from "next";
import { MapaJornada } from "@/components/marketing/mapa-jornada";

export const metadata: Metadata = { title: "Como funciona" };

export default function ComoFuncionaPage() {
  return (
    <div className="container-page py-16">
      {/*
        O título da página some daqui porque o mapa traz o seu próprio cabeçalho
        (selo, título e subtítulo). Manter os dois deixaria "Como funciona" e "Da
        compra à análise jurídica" empilhados dizendo a mesma coisa. O <h1> vive
        agora dentro do mapa, e a página continua com exatamente um.
      */}
      <MapaJornada />

      {/* Card da marca com filete azul, no lugar do quadro âmbar: o âmbar claro
          era cor fixa e, no tema escuro, recebia texto claro por cima (ilegível).
          O card resolve o contraste nos dois temas sozinho. */}
      <div className="card mt-12 border-l-4 p-6" style={{ borderLeftColor: "#4f7cff" }}>
        <h2 className="text-lg">Importante</h2>
        <p className="mt-2 hyphens-auto text-justify leading-relaxed text-neutro-700">
          O Prescrição Pro é uma <strong>ferramenta de apoio</strong>. A análise depende dos documentos
          fornecidos; informações ausentes podem alterar a conclusão. O resultado e a minuta{" "}
          <strong>devem ser revisados por advogado(a) habilitado(a)</strong> e não há garantia de acolhimento da tese
          pelo Poder Judiciário.
        </p>
      </div>

      <div className="mt-10">
        <Link href="/planos" className="btn-primary">Ver planos e começar</Link>
      </div>
    </div>
  );
}
