import { DOCUMENTOS_POR_MATERIA } from "../../legal/checklist-documentos";

/**
 * MOTOR 1: Prescrição Intercorrente (art. 40 da Lei 6.830/1980).
 *
 * ⚠️ VERSÃO PÚBLICA DE EXEMPLO. As instruções de produção deste motor são
 * metodologia proprietária e não acompanham este repositório. Fica a mesma
 * estrutura — matéria, documentos prioritários, pontos a apurar, cálculo e
 * fundamentação — com texto curto e genérico.
 *
 * Um dos três motores independentes da análise dirigida. Cada motor tem os
 * próprios documentos prioritários e instruções; o que é comum às três matérias
 * (formato JSON, regras anti-invenção, citação de página) vive em
 * prompts-materia.ts, que monta o prompt final.
 */

/** Pergunta objetiva que a conclusão responde com SIM ou NÃO. */
export const PERGUNTA_INTERCORRENTE = "Há prescrição intercorrente?";

const DOCUMENTOS = DOCUMENTOS_POR_MATERIA.prescricao_intercorrente
  .map((d) => `- ${d.rotulo}${d.essencial ? " (essencial)" : ""}`)
  .join("\n");

export const MOTOR_INTERCORRENTE = [
  "MATÉRIA SELECIONADA: PRESCRIÇÃO INTERCORRENTE (art. 40 da Lei nº 6.830/1980).",
  "Analise somente esta matéria.",
  "",
  "DOCUMENTOS PRIORITÁRIOS DESTA MATÉRIA (procure-os no texto; nunca presuma o conteúdo dos ausentes):",
  DOCUMENTOS,
  "Quando um documento importante não for localizado, diga expressamente: \"Documento importante não localizado para análise da prescrição intercorrente.\" e liste-o em `documentosAusentes`.",
  "",
  "APURE, sempre que o documento permitir: suspensão e arquivamento do processo, ciência da Fazenda e atos posteriores que possam ter interrompido o prazo.",
  "",
  "CÁLCULO: registre em `calculoPrazo` o marco inicial adotado, o prazo aplicável e a data provável de consumação, comparada com a data atual.",
  "",
  "FUNDAMENTAÇÃO: art. 40 da Lei nº 6.830/1980. Em `precedentes`, cite apenas o que for pertinente ao caso.",
].join("\n");
