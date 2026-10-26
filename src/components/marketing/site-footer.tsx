import Link from "next/link";
import { Logo } from "@/components/ui/logo";
import { FORNECEDOR, pendente } from "@/lib/fornecedor";

// As políticas de assinatura e de créditos moram em /politica-de-* porque a área
// autenticada do cliente já ocupa /assinatura e /creditos, e duas páginas na mesma
// rota quebram a build do App Router (grupos como (app) e (marketing) não entram
// na URL). /reembolso está livre e mantém o nome direto.
const LEGAL = [
  { href: "/termos", label: "Termos de Uso" },
  { href: "/privacidade", label: "Política de Privacidade" },
  { href: "/cookies", label: "Política de Cookies" },
  { href: "/responsabilidade", label: "Aviso de responsabilidade" },
  { href: "/uso-aceitavel", label: "Política de Uso Aceitável" },
  { href: "/politica-de-assinatura", label: "Política de Assinatura" },
  { href: "/politica-de-creditos", label: "Política de Créditos" },
  { href: "/reembolso", label: "Política de Reembolso" },
  { href: "/cancelamento", label: "Cancelamento e retenção" },
];

export function SiteFooter() {
  // Identificação completa do fornecedor: só exibida quando existe de verdade.
  const qualificado = ![FORNECEDOR.cnpj, FORNECEDOR.endereco, FORNECEDOR.email].some(pendente);

  return (
    <footer className="border-t border-neutro-200 bg-white">
      <div className="container-page grid gap-8 py-12 md:grid-cols-4">
        <div className="md:col-span-2">
          <Logo />
          <p className="mt-4 max-w-md text-sm text-neutro-500">
            Sistema de <strong>apoio jurídico</strong> à análise de prescrição e decadência tributária.
            Não substitui a atuação de advogado(a) habilitado(a) nem garante resultado judicial.
          </p>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-neutro-700">Plataforma</h3>
          <ul className="mt-3 space-y-2 text-sm text-neutro-500">
            <li><Link href="/como-funciona" className="hover:text-marinho-700">Como funciona</Link></li>
            <li><Link href="/planos" className="hover:text-marinho-700">Planos</Link></li>
            <li><Link href="/faq" className="hover:text-marinho-700">Perguntas frequentes</Link></li>
            {/* /contato existe e não era alcançável pelo rodapé — o canal de
                atendimento é informação obrigatória num site de venda. */}
            <li><Link href="/contato" className="hover:text-marinho-700">Contato e atendimento</Link></li>
            <li><Link href="/login" className="hover:text-marinho-700">Entrar no sistema</Link></li>
          </ul>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-neutro-700">Documentos legais</h3>
          <ul className="mt-3 space-y-2 text-sm text-neutro-500">
            {LEGAL.map((l) => (
              <li key={l.href}><Link href={l.href} className="hover:text-marinho-700">{l.label}</Link></li>
            ))}
          </ul>
        </div>
      </div>
      {/*
        A identificação do fornecedor vem da constante, não escrita aqui.
        O rodapé dizia "Leão Amorim Tecnologia" enquanto os Termos e a Política de
        Privacidade diziam "Leão Amorim Advocacia" — duas pessoas jurídicas
        diferentes aparecendo como fornecedor do mesmo contrato de adesão. O art. 4º
        do Decreto 7.962/2013 exige identificação inequívoca do fornecedor, com CNPJ
        e endereço, em local de destaque no site de venda.
      */}
      <div className="border-t border-neutro-100">
        <div className="container-page flex flex-col gap-2 py-5 text-xs text-neutro-400">
          <div className="flex flex-col items-center justify-between gap-2 sm:flex-row">
            <span>
              {FORNECEDOR.nomeFantasia} © {new Date().getFullYear()}
              {pendente(FORNECEDOR.razaoSocial) ? "" : ` ${FORNECEDOR.razaoSocial}`}
            </span>
            <span>Uso de IA como ferramenta de apoio. Conteúdo sujeito a revisão jurídica.</span>
          </div>
          {/*
            A linha de qualificação aparece só quando os dados existem. Enquanto
            pendentes, ela é OMITIDA em vez de mostrar "[DEFINIR CNPJ]" ao visitante:
            no rodapé isso lê como site quebrado. O marcador visível fica nos
            documentos legais, onde vem acompanhado do aviso que explica a pendência.
          */}
          {qualificado && (
            <div className="text-center sm:text-left">
              CNPJ {FORNECEDOR.cnpj} — {FORNECEDOR.endereco} — {FORNECEDOR.email}
            </div>
          )}
        </div>
      </div>
    </footer>
  );
}
