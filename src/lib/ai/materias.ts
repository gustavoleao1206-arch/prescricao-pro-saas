import type { AnalysisType } from "@prisma/client";

/**
 * Matérias jurídicas que a análise dirigida cobre.
 *
 * Cada matéria mapeia para um `AnalysisType` que já existe no banco — por isso
 * esta funcionalidade não exigiu migração. O `slug` é o valor trafegado entre
 * interface, API e IA (campo `tipoAnalise` do JSON de resposta).
 */

export const MATERIAS = [
  {
    slug: "prescricao_intercorrente",
    label: "Prescrição Intercorrente",
    tipo: "PRESCRICAO_INTERCORRENTE",
    resumo: "Art. 40 da LEF: paralisação após a suspensão de 1 ano e o arquivamento.",
    // Pergunta objetiva que a conclusão da análise responde com SIM ou NÃO.
    pergunta: "Há prescrição intercorrente?",
  },
  {
    slug: "prescricao_ordinaria",
    label: "Prescrição Ordinária",
    tipo: "PRESCRICAO",
    resumo: "Art. 174 do CTN: 5 anos da constituição definitiva até o ato interruptivo.",
    pergunta: "Existe prescrição ordinária?",
  },
  {
    slug: "decadencia_tributaria",
    label: "Decadência Tributária",
    tipo: "DECADENCIA",
    resumo: "Arts. 150, §4º e 173, I do CTN: prazo para constituir o crédito.",
    pergunta: "Existe decadência?",
  },
] as const satisfies readonly { slug: string; label: string; tipo: AnalysisType; resumo: string; pergunta: string }[];

export type MateriaSlug = (typeof MATERIAS)[number]["slug"];
export type Materia = (typeof MATERIAS)[number];

export const MATERIA_SLUGS = MATERIAS.map((m) => m.slug) as readonly MateriaSlug[];

export function isMateriaSlug(v: unknown): v is MateriaSlug {
  return typeof v === "string" && (MATERIA_SLUGS as readonly string[]).includes(v);
}

export function materiaPorSlug(slug: MateriaSlug): Materia {
  const m = MATERIAS.find((x) => x.slug === slug);
  // MATERIAS é exaustivo sobre MateriaSlug; o fallback existe só para o tipo.
  if (!m) throw new Error(`Matéria desconhecida: ${slug}`);
  return m;
}

/** Converte o `AnalysisType` gravado na análise de volta para a matéria. */
export function materiaPorTipo(tipo: AnalysisType): Materia | null {
  return MATERIAS.find((m) => m.tipo === tipo) ?? null;
}
