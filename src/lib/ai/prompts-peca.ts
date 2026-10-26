import type { MateriaSlug } from "./materias";

/**
 * Instruções de redação da peça (campo `peticao` do JSON).
 *
 * ⚠️ VERSÃO PÚBLICA DE EXEMPLO. A estrutura de produção da peça, as regras de
 * fundamentação, o padrão de redação e os pedidos por matéria são metodologia
 * proprietária e não acompanham este repositório. Fica a mesma estrutura —
 * estrutura da peça, pedidos por matéria e regras contra invenção — com texto
 * curto e genérico.
 */

const ESTRUTURA = [
  "ESTRUTURA DA PEÇA, em markdown: endereçamento, qualificação das partes, fatos, fundamentos, demonstração cronológica, cálculo do prazo, pedidos e fecho.",
  "Na demonstração cronológica, use uma tabela com as colunas | Data | Evento | Fls. | Efeito jurídico |, com a página de cada ato igual à do campo `pagina` da `linhaDoTempo`.",
].join("\n");

const REDACAO = [
  "REDAÇÃO:",
  "- Linguagem técnica e objetiva.",
  "- Dado que não conste dos autos vira marcador entre colchetes, como [NOME DO EXECUTADO] ou [DATA A SER CONFIRMADA]. Não invente dados.",
].join("\n");

/** Pedidos, por matéria. */
const PEDIDOS: Record<MateriaSlug, string> = {
  prescricao_intercorrente:
    "PEDIDOS: o reconhecimento da prescrição intercorrente e a extinção da execução, com os pedidos acessórios cabíveis.",
  prescricao_ordinaria:
    "PEDIDOS: o reconhecimento da prescrição ordinária e a extinção da execução, com os pedidos acessórios cabíveis.",
  decadencia_tributaria:
    "PEDIDOS: o reconhecimento da decadência e a extinção da execução, com os pedidos acessórios cabíveis.",
};

/**
 * Bloco completo de instruções da peça, para o campo `peticao` do JSON.
 * Só faz sentido quando o resultado é positivo — a trava do servidor esvazia
 * a petição nos demais casos.
 */
export function instrucoesDaPeca(materia: MateriaSlug): string {
  return [
    "=== REDAÇÃO DA PEÇA (campo `peticao`) ===",
    "Quando o resultado for positivo, `peticao` recebe a minuta completa, em markdown, para revisão por advogado(a).",
    "",
    ESTRUTURA,
    "",
    PEDIDOS[materia],
    "",
    REDACAO,
  ].join("\n");
}
