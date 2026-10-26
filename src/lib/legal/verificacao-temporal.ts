import type { MateriaSlug } from "../ai/materias";

/**
 * Verificação temporal da conclusão: a trava que impede o sistema de afirmar
 * "prescrição consumada" quando a própria data calculada de consumação está no
 * futuro.
 *
 * MOTIVO (caso real): num processo de IPTU a IA respondeu
 * "SIM, há prescrição intercorrente" tendo ela mesma calculado a consumação
 * para 22/06/2029 — três anos depois da data da análise. A coerência entre a
 * resposta e as datas NÃO pode depender do modelo: é aritmética, e aritmética
 * se faz em código. Este módulo roda no servidor, depois do saneamento da
 * resposta, e corrige o resultado quando as datas o desmentem.
 *
 * Tudo aqui é determinístico e puro (a data "de hoje" entra por parâmetro),
 * portanto testável sem IA e sem banco.
 */

export type SituacaoPrazo = "consumado" | "em_andamento" | "indeterminado";

export interface VerificacaoTemporal {
  /** Data em que a análise foi executada (ISO AAAA-MM-DD), exibida no relatório. */
  dataAnalise: string;
  /** Consumação extraída do cálculo da IA (ISO), quando parseável. */
  dataConsumacao: string | null;
  situacaoPrazo: SituacaoPrazo;
  /** true quando a trava trocou o resultado que a IA deu. */
  corrigido: boolean;
  /** O que a IA tinha respondido, quando houve correção (transparência). */
  resultadoOriginalIA: string | null;
  /** Validações que falharam ou pontos de atenção detectados. */
  inconsistencias: string[];
  /** Memória de cálculo GERADA PELO SISTEMA (não pela IA), linha a linha. */
  memoriaCalculo: string[];
}

// ---------------------------------------------------------------------------
// Datas: parsing tolerante e aritmética
// ---------------------------------------------------------------------------

const MESES: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, março: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

/**
 * Extrai a PRIMEIRA data reconhecível de um texto. Aceita "22/06/2023",
 * "22.06.2023", "2023-06-22" e "22 de junho de 2023" — os formatos que a IA e
 * os documentos processuais realmente usam. Devolve null quando não há data,
 * nunca chuta.
 *
 * A hora é fixada ao meio-dia UTC para a comparação de dias não escorregar com
 * fuso horário.
 */
export function extrairData(texto: string | null | undefined): Date | null {
  if (!texto) return null;

  const ddmmaaaa = /(\b[0-3]?\d)[/.]([01]?\d)[/.](\d{4})\b/.exec(texto);
  if (ddmmaaaa) {
    const [, d, m, a] = ddmmaaaa;
    return dataValida(Number(a), Number(m), Number(d));
  }

  const iso = /\b(\d{4})-([01]\d)-([0-3]\d)\b/.exec(texto);
  if (iso) {
    const [, a, m, d] = iso;
    return dataValida(Number(a), Number(m), Number(d));
  }

  const extenso = /\b([0-3]?\d)\s+de\s+([a-zç]+)\s+de\s+(\d{4})\b/i.exec(texto.normalize("NFC"));
  if (extenso) {
    const mes = MESES[extenso[2]!.toLowerCase()];
    if (mes) return dataValida(Number(extenso[3]), mes, Number(extenso[1]));
  }

  return null;
}

function dataValida(ano: number, mes: number, dia: number): Date | null {
  if (ano < 1900 || ano > 2200 || mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  const d = new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
  // Rejeita datas impossíveis (31/02 viraria 03/03 silenciosamente).
  if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return d;
}

/** Soma anos preservando dia/mês (31/xx cai para o último dia do mês quando preciso). */
export function somarAnos(d: Date, anos: number): Date {
  const alvo = new Date(Date.UTC(d.getUTCFullYear() + anos, d.getUTCMonth(), 1, 12));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d.getUTCDate(), ultimoDia));
  return alvo;
}

export function formatarBR(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

function formatarISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Compara por DIA (ignora horas): consumação até hoje inclusive = prazo completo. */
function mesmoDiaOuAntes(a: Date, b: Date): boolean {
  return formatarISO(a) <= formatarISO(b);
}

// ---------------------------------------------------------------------------
// Verificação de coerência
// ---------------------------------------------------------------------------

interface EntradaVerificacao {
  resultado: "positivo" | "negativo" | "inconclusivo";
  marcoInicial: string;
  dataProvavelConsumacao: string;
  marcoFinal: string;
}

export interface ResultadoVerificacao {
  verificacao: VerificacaoTemporal;
  /** Resultado após a trava (pode ter sido corrigido). */
  resultadoFinal: "positivo" | "negativo" | "inconclusivo";
}

const ROTULO_IA: Record<string, string> = {
  positivo: "consumada (SIM)",
  negativo: "não consumada (NÃO)",
  inconclusivo: "inconclusiva",
};

/**
 * Aplica as validações temporais obrigatórias e corrige o resultado quando as
 * datas o desmentem.
 *
 * Regras (na ordem):
 *  1. "Consumada" com data de consumação NO FUTURO → vira "não consumada",
 *     com registro da correção. É a trava principal.
 *  2. "Consumada" sem data de consumação verificável, ou sem marco inicial
 *     documentado → vira "inconclusiva". Ausência de prova não vira presunção
 *     favorável.
 *  3. "Não consumada" com data futura conhecida → situação "em andamento"
 *     (informativo, sem corrigir).
 *  4. "Não consumada" com data já vencida → NÃO promove a consumada (pode haver
 *     interrupção que a IA considerou e o parser não vê); registra a divergência
 *     para o(a) advogado(a) conferir.
 */
export function verificarCoerenciaTemporal(
  entrada: EntradaVerificacao,
  materia: MateriaSlug,
  agora: Date = new Date(),
): ResultadoVerificacao {
  const inconsistencias: string[] = [];
  const consumacao = extrairData(entrada.dataProvavelConsumacao) ?? extrairData(entrada.marcoFinal);
  const marco = extrairData(entrada.marcoInicial);

  let resultadoFinal = entrada.resultado;
  let corrigido = false;
  let situacaoPrazo: SituacaoPrazo = "indeterminado";

  if (consumacao) {
    situacaoPrazo = mesmoDiaOuAntes(consumacao, agora) ? "consumado" : "em_andamento";
  }

  if (entrada.resultado === "positivo") {
    if (consumacao && !mesmoDiaOuAntes(consumacao, agora)) {
      // Trava principal: consumação no futuro nunca sustenta "consumada".
      resultadoFinal = "negativo";
      corrigido = true;
      inconsistencias.push(
        `Contradição detectada e corrigida automaticamente: a resposta indicava prescrição consumada, mas a ` +
          `data provável de consumação (${formatarBR(consumacao)}) é posterior à data da análise (${formatarBR(agora)}).`,
      );
    } else if (!consumacao) {
      resultadoFinal = "inconclusivo";
      corrigido = true;
      inconsistencias.push(
        "A resposta indicava prescrição consumada, porém sem data de consumação verificável no cálculo. " +
          "Sem a data não há como confirmar o transcurso integral do prazo; o resultado foi reclassificado como inconclusivo.",
      );
    } else if (!marco) {
      resultadoFinal = "inconclusivo";
      corrigido = true;
      inconsistencias.push(
        "A resposta indicava prescrição consumada, porém sem marco inicial documentalmente identificável " +
          "(data da ciência da Fazenda). Ausência de prova não gera presunção favorável; o resultado foi " +
          "reclassificado como inconclusivo.",
      );
    }
  } else if (entrada.resultado === "negativo" && consumacao && mesmoDiaOuAntes(consumacao, agora)) {
    inconsistencias.push(
      `Atenção: a data provável de consumação (${formatarBR(consumacao)}) já passou, mas a análise concluiu pela ` +
        `não consumação. Pode haver causa interruptiva ou suspensiva considerada no texto; conferir com atenção.`,
    );
  } else if (entrada.resultado === "inconclusivo" && marco) {
    // Classificação B da especificação: com marco inicial DOCUMENTADO e a
    // contagem legal apontando consumação no futuro, o resultado correto é
    // "ainda não consumada" — as pendências documentais (hipótese de marco
    // anterior, pesquisas faltantes) ficam registradas, mas não mudam a
    // aritmética do marco comprovado. Só se aplica quando a consumação
    // calculada está no futuro: se estiver no passado, permanece inconclusivo,
    // porque promover a "consumada" exigiria prova, não presunção.
    const consumacaoSistema =
      materia === "prescricao_intercorrente" ? somarAnos(somarAnos(marco, 1), 5) : somarAnos(marco, 5);
    if (!mesmoDiaOuAntes(consumacaoSistema, agora)) {
      resultadoFinal = "negativo";
      corrigido = true;
      situacaoPrazo = "em_andamento";
      inconsistencias.push(
        `Reclassificação automática: há marco inicial documentado (${formatarBR(marco)}) e a contagem legal indica ` +
          `consumação em ${formatarBR(consumacaoSistema)}, posterior à data da análise (${formatarBR(agora)}). ` +
          `Pela regra de classificação, o resultado é "ainda não consumada". As pendências documentais apontadas ` +
          `pela análise permanecem registradas e devem ser supridas.`,
      );
      return {
        resultadoFinal,
        verificacao: {
          dataAnalise: formatarISO(agora),
          dataConsumacao: formatarISO(consumacaoSistema),
          situacaoPrazo,
          corrigido,
          resultadoOriginalIA: ROTULO_IA[entrada.resultado] ?? entrada.resultado,
          inconsistencias,
          memoriaCalculo: memoriaDeCalculo(entrada, materia, agora),
        },
      };
    }
  }

  return {
    resultadoFinal,
    verificacao: {
      dataAnalise: formatarISO(agora),
      dataConsumacao: consumacao ? formatarISO(consumacao) : null,
      situacaoPrazo: resultadoFinal === "inconclusivo" && !consumacao ? "indeterminado" : situacaoPrazo,
      corrigido,
      resultadoOriginalIA: corrigido ? ROTULO_IA[entrada.resultado] ?? entrada.resultado : null,
      inconsistencias,
      memoriaCalculo: memoriaDeCalculo(entrada, materia, agora),
    },
  };
}

/**
 * Memória de cálculo gerada PELO SISTEMA a partir do marco inicial (ciência),
 * linha a linha, como a especificação exige. Só é montada quando o marco tem
 * data parseável — o sistema não inventa contagem sem data.
 *
 * Na intercorrente aplica a sistemática do art. 40 (1 ano de suspensão + 5 de
 * prescrição). Nas demais matérias, o prazo quinquenal direto.
 */
export function memoriaDeCalculo(
  entrada: Pick<EntradaVerificacao, "marcoInicial" | "dataProvavelConsumacao" | "marcoFinal">,
  materia: MateriaSlug,
  agora: Date,
): string[] {
  const marco = extrairData(entrada.marcoInicial);
  if (!marco) return [];

  const linhas: string[] = [];
  let consumacaoCalculada: Date;

  if (materia === "prescricao_intercorrente") {
    const fimSuspensao = somarAnos(marco, 1);
    consumacaoCalculada = somarAnos(fimSuspensao, 5);
    linhas.push(
      `Ciência da Fazenda (marco adotado): ${formatarBR(marco)}`,
      `+ 1 ano de suspensão (art. 40, caput e §1º, da LEF) = ${formatarBR(fimSuspensao)}`,
      `Início do prazo prescricional de 5 anos: ${formatarBR(fimSuspensao)}`,
      `+ 5 anos (art. 40, §4º, da LEF; Súmula 314/STJ) = ${formatarBR(consumacaoCalculada)}`,
    );
  } else {
    consumacaoCalculada = somarAnos(marco, 5);
    linhas.push(
      `Marco inicial adotado: ${formatarBR(marco)}`,
      `+ 5 anos = ${formatarBR(consumacaoCalculada)}`,
    );
  }

  linhas.push(`Data da análise: ${formatarBR(agora)}`);
  linhas.push(
    mesmoDiaOuAntes(consumacaoCalculada, agora)
      ? `Conclusão da contagem: o prazo já se completou em ${formatarBR(consumacaoCalculada)}, salvo causa interruptiva ou suspensiva.`
      : `Conclusão da contagem: o prazo ainda não foi completado (faltam ${formatarBR(consumacaoCalculada)}).`,
  );

  // Divergência entre a conta do sistema e a data que a IA declarou: não se
  // corrige a da IA (pode haver suspensões que a aritmética simples não vê),
  // mas o(a) advogado(a) precisa saber que os números não batem.
  const consumacaoIA = extrairData(entrada.dataProvavelConsumacao) ?? extrairData(entrada.marcoFinal);
  if (consumacaoIA) {
    const diferencaDias = Math.abs(consumacaoCalculada.getTime() - consumacaoIA.getTime()) / 86_400_000;
    if (diferencaDias > 45) {
      linhas.push(
        `Atenção: a data de consumação informada na análise (${formatarBR(consumacaoIA)}) difere da contagem ` +
          `aritmética acima (${formatarBR(consumacaoCalculada)}). Conferir se há suspensões ou interrupções que justifiquem.`,
      );
    }
  }

  return linhas;
}
