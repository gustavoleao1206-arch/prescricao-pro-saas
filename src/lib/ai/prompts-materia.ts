import type { MateriaSlug } from "./materias";
import { instrucoesDaPeca } from "./prompts-peca";
import { MOTOR_INTERCORRENTE } from "./motores/intercorrente";
import { MOTOR_ORDINARIA } from "./motores/ordinaria";
import { MOTOR_DECADENCIA } from "./motores/decadencia";
import { checklistEmTexto, type ChecklistDocumentos } from "../legal/checklist-documentos";

/**
 * Montagem do prompt da ANÁLISE DIRIGIDA.
 *
 * ⚠️ VERSÃO PÚBLICA DE EXEMPLO. As regras de conclusão e as instruções de
 * produção são metodologia proprietária e não acompanham este repositório. Fica
 * a mesma estrutura — motor da matéria, checklist prévio, regras de conclusão,
 * citação de página, trava da petição, regras contra invenção, instruções da
 * peça e o esquema JSON — com texto curto e genérico.
 *
 * O esquema JSON é o contrato com `sanearResultado` (analise-dirigida.ts) e as
 * classificações da linha do tempo são as que o código reconhece; por isso os
 * dois ficam completos.
 */

/** Aviso obrigatório ao final de toda análise (item 17 da especificação). */
export const AVISO_LEGAL_ANALISE =
  "Esta análise foi gerada por inteligência artificial com base nos documentos enviados e possui caráter auxiliar. " +
  "O resultado deve ser conferido e validado por advogado antes da adoção de qualquer medida judicial ou administrativa. " +
  "A ferramenta não garante o acolhimento da tese pelo Poder Judiciário ou pela Administração Pública.";

const REGRAS_ANTI_ALUCINACAO = [
  "REGRAS INEGOCIÁVEIS CONTRA INVENÇÃO:",
  "- Não invente datas, páginas, documentos, valores, números de processo, dispositivos legais ou precedentes.",
  "- Toda afirmação factual precisa estar vinculada a algo localizado no texto fornecido.",
  "- Quando a informação não estiver no documento, escreva exatamente: \"Informação não localizada no documento analisado.\"",
  "- Não use expressões absolutas como \"causa ganha\", \"direito garantido\" ou \"prescrição garantida\".",
].join("\n");

const REGRAS_PAGINA = [
  "CITAÇÃO DE PÁGINAS:",
  "- O texto vem marcado por página, no formato \"--- arquivo.pdf p.N ---\". Use esse N no campo `pagina` de cada evento.",
  "- Se não for possível determinar a página de um fato, deixe `pagina` vazio.",
].join("\n");

const REGRAS_CONCLUSAO = [
  "CONCLUSÃO E CONSISTÊNCIA:",
  '- `resultado` = "positivo" quando o prazo estiver transcorrido e documentado; "negativo" quando não estiver; "inconclusivo" quando faltar documento para decidir.',
  "- Datas em `calculoPrazo` no formato DD/MM/AAAA.",
  '- `grauConsistencia` = "alta" | "moderada" | "baixa"; `justificativaConfianca` e `estrategiaRecomendada` são obrigatórias.',
  "- DOCUMENTOS POSTERIORES: NUNCA presuma o conteúdo de atos que não constam do arquivo; registre a limitação em `documentosAusentes`.",
  "",
  "LINHA DO TEMPO — `classificacao` de cada evento (use exatamente um destes valores): ajuizamento | despacho-citatorio | citacao | tentativa-localizacao | pesquisa-patrimonial | manifestacao-fazenda | mera-intimacao | inercia | suspensao | ciencia-fazenda | arquivamento | desarquivamento | penhora | bloqueio | pagamento | parcelamento | contraditorio | decisao | sentenca | recurso | mera-movimentacao.",
  '- `confianca` de cada evento: "alta" | "moderada" | "baixa".',
].join("\n");

const REGRAS_PECA = [
  "MEDIDA PROCESSUAL E PETIÇÃO:",
  '- Preencha `peticao` SOMENTE quando `resultado` = "positivo". Em "negativo" ou "inconclusivo", `peticao` deve ser string vazia.',
  "- Explique a medida escolhida em `justificativaMedida`.",
].join("\n");

const ESQUEMA_JSON = [
  "FORMATO DA RESPOSTA — retorne JSON válido, EXCLUSIVAMENTE neste formato, sem texto fora do JSON:",
  "{",
  '  "tipoAnalise": "prescricao_intercorrente" | "prescricao_ordinaria" | "decadencia_tributaria",',
  '  "resultado": "positivo" | "negativo" | "inconclusivo",',
  '  "grauConsistencia": "alta" | "moderada" | "baixa",',
  '  "conclusao": string,',
  '  "resumoExecutivo": string,',
  '  "linhaDoTempo": [{ "data": string, "evento": string, "pagina": string, "classificacao": string, "efeitoJuridico": string, "relevancia": "alta"|"media"|"baixa", "confianca": "alta"|"moderada"|"baixa" }],',
  '  "calculoPrazo": {',
  '    "marcoInicial": string, "prazoAplicavel": string,',
  '    "periodosSuspensao": string[], "atosInterruptivos": string[],',
  '    "marcoFinal": string, "dataProvavelConsumacao": string, "explicacao": string',
  "  },",
  '  "fundamentacaoLegal": string[],',
  '  "precedentes": string[],',
  '  "elementosFavoraveis": string[],',
  '  "riscos": string[],',
  '  "documentosUtilizados": string[],',
  '  "documentosAusentes": string[],',
  '  "pontosParaAvaliacao": string[],',
  '  "justificativaConfianca": string,',
  '  "estrategiaRecomendada": string,',
  '  "medidaProcessualSugerida": string,',
  '  "justificativaMedida": string,',
  '  "peticao": string',
  "}",
].join("\n");

// ---------------------------------------------------------------------------
// Motores — um arquivo por matéria (src/lib/ai/motores/)
// ---------------------------------------------------------------------------

const POR_MATERIA: Record<MateriaSlug, string> = {
  prescricao_intercorrente: MOTOR_INTERCORRENTE,
  prescricao_ordinaria: MOTOR_ORDINARIA,
  decadencia_tributaria: MOTOR_DECADENCIA,
};

/**
 * Monta o bloco de instruções da matéria, para ser acrescentado ao prompt de
 * sistema ativo e à base de conhecimento ativa.
 *
 * `checklist` é o resultado da detecção determinística de documentos feita
 * ANTES da análise: vai no prompt para a IA saber, de saída, o que existe e o
 * que falta.
 */
export function instrucoesDaMateria(slug: MateriaSlug, checklist?: ChecklistDocumentos): string {
  return [
    POR_MATERIA[slug],
    "",
    ...(checklist
      ? [
          "=== RESULTADO DA DETECÇÃO PRÉVIA DE DOCUMENTOS ===",
          checklistEmTexto(checklist),
          "Confirme cada item no texto: o que confirmar ausente entra em `documentosAusentes`.",
          "",
        ]
      : []),
    REGRAS_CONCLUSAO,
    "",
    REGRAS_PAGINA,
    "",
    REGRAS_PECA,
    "",
    REGRAS_ANTI_ALUCINACAO,
    "",
    instrucoesDaPeca(slug),
    "",
    ESQUEMA_JSON,
  ].join("\n");
}
