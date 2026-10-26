import { ATUALIZADO_EM, VERSAO_DOCUMENTOS, dataBR, pendenciasDoFornecedor } from "@/lib/fornecedor";

/**
 * Moldura comum dos documentos legais.
 *
 * ── O aviso do topo deixou de ser fixo ────────────────────────────────────────
 * Antes, TODA página legal exibia "Documento em versão preliminar (modelo). Deve
 * ser revisado por advogado(a)" e "Última atualização: configurável no painel
 * administrativo" — uma data que não existia em painel nenhum. Dois problemas: o
 * texto continuaria dizendo "modelo" depois de revisado, e um contrato de adesão
 * que anuncia a si mesmo como rascunho é convite a alegar que não obriga ninguém.
 *
 * Agora o aviso é CONDICIONAL: aparece só enquanto faltar preencher a identificação
 * do fornecedor (razão social, CNPJ, endereço, Encarregado). Faltando esses dados o
 * documento realmente não está publicável — o art. 4º do Decreto 7.962/2013 exige
 * identificação em destaque. Preenchidos, o aviso desaparece sozinho e fica a marca
 * de versão e data, que é o que o art. 46 do CDC pede para o cliente saber o que
 * aceitou.
 */
export function LegalShell({
  title,
  children,
  /** Data específica deste documento, quando diferir da revisão geral. */
  atualizadoEm = ATUALIZADO_EM,
  versao = VERSAO_DOCUMENTOS,
}: {
  title: string;
  children: React.ReactNode;
  atualizadoEm?: string;
  versao?: string;
}) {
  const pendencias = pendenciasDoFornecedor();

  return (
    <div className="container-page py-16">
      {pendencias.length > 0 && (
        <div className="mb-6 rounded-xl border border-atencao-100 bg-atencao-50 p-4 text-sm text-atencao">
          <p className="font-semibold">Documento pendente de dados do fornecedor.</p>
          <p className="mt-1">
            Faltam preencher, em <code>src/lib/fornecedor.ts</code>: {pendencias.join(", ")}. Enquanto isso, os trechos
            marcados com <strong>[DEFINIR]</strong> aparecem no texto.
          </p>
        </div>
      )}

      {/*
        Texto corrido justificado em UM ponto só: as variantes atingem apenas
        parágrafos e itens de lista, nunca os títulos, que ficariam com buracos
        entre palavras quando quebram em duas linhas. `hyphens-auto` depende do
        lang="pt-BR" declarado no layout raiz e é o que evita rios de espaço.
      */}
      <article className="prose-legal max-w-3xl text-neutro-700 [&_li]:hyphens-auto [&_li]:text-justify [&_p]:hyphens-auto [&_p]:text-justify">
        <h1>{title}</h1>
        <p className="text-sm text-neutro-500">
          Versão {versao} — vigente desde {dataBR(atualizadoEm)}.
        </p>
        {children}
      </article>
    </div>
  );
}
