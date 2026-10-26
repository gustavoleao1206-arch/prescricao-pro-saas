import { DOCUMENTOS_POR_MATERIA } from "../../legal/checklist-documentos";

/**
 * MOTOR 3: Decadência Tributária (arts. 150, §4º e 173 do CTN).
 *
 * ⚠️ VERSÃO PÚBLICA DE EXEMPLO. As instruções de produção deste motor são
 * metodologia proprietária e não acompanham este repositório. Fica a mesma
 * estrutura, com texto curto e genérico. Ver o cabeçalho de
 * motores/intercorrente.ts para a divisão de responsabilidades.
 */

/** Pergunta objetiva que a conclusão responde com SIM ou NÃO. */
export const PERGUNTA_DECADENCIA = "Existe decadência?";

const DOCUMENTOS = DOCUMENTOS_POR_MATERIA.decadencia_tributaria
  .map((d) => `- ${d.rotulo}${d.essencial ? " (essencial)" : ""}`)
  .join("\n");

export const MOTOR_DECADENCIA = [
  "MATÉRIA SELECIONADA: DECADÊNCIA TRIBUTÁRIA (arts. 150, §4º e 173 do CTN).",
  "Analise somente esta matéria.",
  "",
  "DOCUMENTOS PRIORITÁRIOS DESTA MATÉRIA (procure-os no texto; nunca presuma o conteúdo dos ausentes):",
  DOCUMENTOS,
  "Quando um documento importante não for localizado, diga expressamente: \"Documento importante não localizado para análise da decadência.\" e liste-o em `documentosAusentes`.",
  "",
  "APURE, sempre que o documento permitir: fato gerador, modalidade de lançamento, notificação do lançamento e decisões administrativas.",
  "",
  "CÁLCULO: registre em `calculoPrazo` o marco inicial adotado, o prazo aplicável e a data provável de consumação, comparada com a data atual.",
  "",
  "FUNDAMENTAÇÃO: arts. 150, §4º, e 173 do CTN. Em `precedentes`, cite apenas o que for pertinente ao caso.",
].join("\n");
