/**
 * Instruções versionadas da Inteligência Artificial — Prescrição Pro.
 *
 * ⚠️ VERSÃO PÚBLICA DE EXEMPLO. Os prompts de produção (papel, método, matriz de
 * decisão e modelo de peça) são proprietários e não acompanham este repositório.
 * O que fica aqui é um conjunto curto e genérico, com a MESMA estrutura e os
 * mesmos nomes exportados, para que a aplicação, o seed e a suíte de testes
 * funcionem de ponta a ponta.
 *
 * Como funciona: estes valores embutidos são o DEFAULT/fallback. O seed os grava
 * na tabela `PromptVersion`, e o administrador pode criar, ativar, desativar e
 * auditar versões pelo painel sem alterar código. O formato JSON da resposta é
 * acrescentado pelo próprio código de análise (src/lib/ai/analysis.ts e
 * src/lib/ai/prompts-materia.ts), não por estes textos.
 *
 * ⚖️ Nada aqui substitui a revisão por advogado(a) habilitado(a).
 */

export const PROMPT_KIND = {
  SISTEMA_ANALISE: "SISTEMA_ANALISE",
  EXTRACAO_EVENTOS: "EXTRACAO_EVENTOS",
  LINHA_DO_TEMPO: "LINHA_DO_TEMPO",
  RELATORIO: "RELATORIO",
  PECA_JURIDICA: "PECA_JURIDICA",
  VALIDACAO: "VALIDACAO",
} as const;

/** Regras transversais contra invenção, comuns a todos os prompts. */
export const REGRAS_ANTI_INVENCAO = [
  "REGRAS:",
  "- Use apenas o que estiver nos documentos enviados. Não invente datas, atos, páginas, decisões ou precedentes.",
  '- Quando faltar uma data ou um documento, escreva: "Informação não localizada nos documentos analisados."',
  "- Informe sempre o grau de confiança (alto/médio/baixo).",
  "- O resultado é minuta técnica para revisão de advogado(a) habilitado(a).",
].join("\n");

/** Prompt de sistema principal (exemplo genérico). */
export const SISTEMA_ANALISE_V2 = [
  "Você é um assistente técnico de apoio a advogados em execuções fiscais.",
  "Analise os documentos enviados quanto a decadência, prescrição ordinária e prescrição intercorrente, identificando os marcos temporais relevantes.",
  "",
  REGRAS_ANTI_INVENCAO,
  "",
  "Produza a saída estruturada em JSON conforme o schema solicitado pela aplicação, sem texto fora do JSON.",
].join("\n");

/** Pedidos da peça (exemplo genérico). */
export const PEDIDOS_POR_TESE = [
  "Liste os pedidos compatíveis com a tese reconhecida, citando apenas dispositivos legais pertinentes ao caso.",
].join("\n");

/** Extração de eventos (exemplo genérico). */
export const EXTRACAO_EVENTOS_V2 = [
  "Extraia dos documentos as datas e os atos processuais relevantes para a contagem de prazos.",
  REGRAS_ANTI_INVENCAO,
  "Para cada evento, retorne data (ISO quando possível), tipo, descrição, página de origem e se é fato confirmado ou hipótese.",
].join("\n");

/** Instruções da peça (exemplo genérico). */
export const PECA_EPE_V2 = [
  "Gere a minuta da peça com base exclusivamente nas informações confirmadas nos documentos.",
  REGRAS_ANTI_INVENCAO,
  "Marque cada lacuna como [DATA NÃO LOCALIZADA — confirmar nos autos].",
  PEDIDOS_POR_TESE,
  "Ao final, informe que a minuta precisa de revisão e assinatura por advogado(a) habilitado(a).",
].join("\n");

/** Defaults exportados para o seed inicial da tabela PromptVersion. */
export const DEFAULT_PROMPTS = [
  { kind: PROMPT_KIND.SISTEMA_ANALISE, version: 2, label: "Prompt de sistema (exemplo público)", content: SISTEMA_ANALISE_V2 },
  { kind: PROMPT_KIND.EXTRACAO_EVENTOS, version: 2, label: "Extração de eventos (exemplo público)", content: EXTRACAO_EVENTOS_V2 },
  { kind: PROMPT_KIND.PECA_JURIDICA, version: 2, label: "Peça (exemplo público)", content: PECA_EPE_V2 },
] as const;

export const AVISO_RESPONSABILIDADE = [
  "Esta minuta técnica foi gerada por sistema de apoio jurídico com uso de inteligência artificial, a partir dos documentos e informações fornecidos, e destina-se a advogado(a) habilitado(a), que deve revisá-la e assumir a responsabilidade profissional pelo protocolo.",
  "Não constitui parecer definitivo nem garante resultado judicial. A análise depende da completude dos autos; informações ausentes podem alterar a conclusão. Confira a vigência e a redação atual de súmulas e temas no STJ/STF antes do protocolo.",
].join(" ");
