import { AVISO_LEGAL_ANALISE } from "./prompts-materia";
import { isMateriaSlug, type MateriaSlug } from "./materias";
import {
  verificarCoerenciaTemporal,
  extrairData,
  somarAnos,
  formatarBR,
  type VerificacaoTemporal,
} from "../legal/verificacao-temporal";

/**
 * Resultado da análise dirigida — o contrato entre a IA, o banco e a interface.
 *
 * `sanearResultado` é a fronteira de confiança: a IA é uma fonte externa e
 * pode devolver campo faltando, enum inválido ou — o caso que mais importa —
 * uma petição junto de um resultado negativo. A regra de que só resultado
 * positivo gera peça é aplicada AQUI, no servidor, e não na interface.
 */

export type ResultadoAnalise = "positivo" | "negativo" | "inconclusivo";
export type GrauConsistencia = "alta" | "moderada" | "baixa";
export type Relevancia = "alta" | "media" | "baixa";

export interface EventoLinhaTempo {
  data: string;
  evento: string;
  pagina: string;
  /** ajuizamento, citacao, suspensao, ciencia-fazenda, mera-intimacao, penhora… */
  classificacao: string;
  efeitoJuridico: string;
  relevancia: Relevancia;
  /** Grau de confiança da EXTRAÇÃO deste evento do documento. */
  confianca: GrauConsistencia;
}

export interface CalculoPrazo {
  marcoInicial: string;
  prazoAplicavel: string;
  periodosSuspensao: string[];
  atosInterruptivos: string[];
  marcoFinal: string;
  dataProvavelConsumacao: string;
  explicacao: string;
}

export interface AnaliseDirigida {
  tipoAnalise: MateriaSlug;
  resultado: ResultadoAnalise;
  grauConsistencia: GrauConsistencia;
  conclusao: string;
  resumoExecutivo: string;
  linhaDoTempo: EventoLinhaTempo[];
  calculoPrazo: CalculoPrazo;
  fundamentacaoLegal: string[];
  precedentes: string[];
  elementosFavoraveis: string[];
  riscos: string[];
  documentosUtilizados: string[];
  documentosAusentes: string[];
  pontosParaAvaliacao: string[];
  /** Bloco 11: por que o grau de confiança recebeu esta classificação. */
  justificativaConfianca: string;
  /** Bloco 8: orientação processual prática, presente em QUALQUER resultado. */
  estrategiaRecomendada: string;
  medidaProcessualSugerida: string;
  justificativaMedida: string;
  peticao: string;
  avisoLegal: string;
  /**
   * Verificação temporal feita PELO SISTEMA (não pela IA): data da análise,
   * situação do prazo, memória de cálculo e eventuais correções aplicadas.
   * É a prova de que a conclusão não contradiz as datas.
   */
  verificacaoTemporal: VerificacaoTemporal;
}

/** Rótulo destacado da conclusão (item 9 da especificação). */
export const ROTULO_RESULTADO: Record<ResultadoAnalise, string> = {
  positivo: "SIM, FORAM IDENTIFICADOS ELEMENTOS FAVORÁVEIS",
  negativo: "NÃO FORAM IDENTIFICADOS ELEMENTOS SUFICIENTES",
  inconclusivo: "ANÁLISE INCONCLUSIVA: DOCUMENTAÇÃO INSUFICIENTE",
};

/** Resposta objetiva à pergunta da matéria (bloco 1 da conclusão padronizada). */
export const RESPOSTA_OBJETIVA: Record<ResultadoAnalise, "SIM" | "NÃO" | "INCONCLUSIVO"> = {
  positivo: "SIM",
  negativo: "NÃO",
  inconclusivo: "INCONCLUSIVO",
};

/**
 * Rótulo da conclusão POR MATÉRIA, nos textos exatos da especificação. O
 * "negativo" diz "ainda não consumada" — que é juridicamente preciso tanto para
 * o prazo em andamento quanto para o interrompido (recomeça, não some).
 */
export function rotuloConclusao(materia: MateriaSlug, resultado: ResultadoAnalise): string {
  const NOME: Record<MateriaSlug, string> = {
    prescricao_intercorrente: "PRESCRIÇÃO INTERCORRENTE",
    prescricao_ordinaria: "PRESCRIÇÃO ORDINÁRIA",
    decadencia_tributaria: "DECADÊNCIA",
  };
  if (resultado === "positivo") return `SIM — ${NOME[materia]} CONSUMADA.`;
  if (resultado === "negativo") return `NÃO — ${NOME[materia]} AINDA NÃO CONSUMADA.`;
  return "INCONCLUSIVA — NECESSIDADE DE DOCUMENTOS COMPLEMENTARES.";
}

/** Grau de confiança como exibido ao cliente (Alto/Médio/Baixo). */
export const GRAU_CONFIANCA: Record<GrauConsistencia, "Alto" | "Médio" | "Baixo"> = {
  alta: "Alto",
  moderada: "Médio",
  baixa: "Baixo",
};

export const NAO_LOCALIZADO = "Informação não localizada no documento analisado.";

const RESULTADOS: ResultadoAnalise[] = ["positivo", "negativo", "inconclusivo"];
const GRAUS: GrauConsistencia[] = ["alta", "moderada", "baixa"];
const RELEVANCIAS: Relevancia[] = ["alta", "media", "baixa"];

/** Expressões absolutas proibidas (item 9). Se aparecerem, são neutralizadas. */
const EXPRESSOES_PROIBIDAS = [
  /causa\s+ganha/gi,
  /direito\s+garantido/gi,
  /resultado\s+judicial\s+certo/gi,
  /prescri[çc][ãa]o\s+garantida/gi,
  /decad[êe]ncia\s+garantida/gi,
];

function texto(v: unknown, padrao = ""): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : padrao;
}

function lista(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x.trim() : String(x ?? ""))).filter((s) => s.length > 0);
}

function umDe<T extends string>(v: unknown, permitidos: T[], padrao: T): T {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (permitidos as string[]).includes(s) ? (s as T) : padrao;
}

function semExpressoesAbsolutas(s: string): string {
  let out = s;
  for (const re of EXPRESSOES_PROIBIDAS) out = out.replace(re, "tese com elementos favoráveis");
  return out;
}

function normalizarEventos(v: unknown): EventoLinhaTempo[] {
  if (!Array.isArray(v)) return [];
  const out: EventoLinhaTempo[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    const evento = texto(e.evento);
    if (!evento) continue; // evento sem descrição não entra na linha do tempo
    out.push({
      data: texto(e.data, NAO_LOCALIZADO),
      evento,
      pagina: texto(e.pagina),
      classificacao: texto(e.classificacao),
      efeitoJuridico: texto(e.efeitoJuridico),
      relevancia: umDe(e.relevancia, RELEVANCIAS, "media"),
      confianca: umDe(e.confianca, GRAUS, "moderada"),
    });
  }
  return out;
}

function normalizarCalculo(v: unknown): CalculoPrazo {
  const c = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  return {
    marcoInicial: texto(c.marcoInicial, NAO_LOCALIZADO),
    prazoAplicavel: texto(c.prazoAplicavel, NAO_LOCALIZADO),
    periodosSuspensao: lista(c.periodosSuspensao),
    atosInterruptivos: lista(c.atosInterruptivos),
    marcoFinal: texto(c.marcoFinal, NAO_LOCALIZADO),
    dataProvavelConsumacao: texto(c.dataProvavelConsumacao, NAO_LOCALIZADO),
    explicacao: texto(c.explicacao, NAO_LOCALIZADO),
  };
}

/**
 * Converte a resposta crua da IA no contrato interno, aplicando as regras que
 * não podem depender de boa vontade do modelo.
 *
 * `agora` existe para os testes fixarem a data da análise; em produção é o
 * relógio do servidor, obtido dinamicamente como a especificação exige.
 */
export function sanearResultado(cru: unknown, materiaEsperada: MateriaSlug, agora: Date = new Date()): AnaliseDirigida {
  const p = (typeof cru === "object" && cru !== null ? cru : {}) as Record<string, unknown>;

  // A matéria é a que o usuário escolheu; o que a IA disser não sobrepõe isso.
  const tipoAnalise = isMateriaSlug(p.tipoAnalise) && p.tipoAnalise === materiaEsperada ? p.tipoAnalise : materiaEsperada;

  const resultado = umDe<ResultadoAnalise>(p.resultado, RESULTADOS, "inconclusivo");

  const analise: AnaliseDirigida = {
    tipoAnalise,
    resultado,
    grauConsistencia: umDe<GrauConsistencia>(p.grauConsistencia, GRAUS, "baixa"),
    conclusao: semExpressoesAbsolutas(texto(p.conclusao, ROTULO_RESULTADO[resultado])),
    resumoExecutivo: semExpressoesAbsolutas(texto(p.resumoExecutivo, NAO_LOCALIZADO)),
    linhaDoTempo: normalizarEventos(p.linhaDoTempo),
    calculoPrazo: normalizarCalculo(p.calculoPrazo),
    fundamentacaoLegal: lista(p.fundamentacaoLegal),
    precedentes: lista(p.precedentes),
    elementosFavoraveis: lista(p.elementosFavoraveis),
    riscos: lista(p.riscos),
    documentosUtilizados: lista(p.documentosUtilizados),
    documentosAusentes: lista(p.documentosAusentes),
    pontosParaAvaliacao: lista(p.pontosParaAvaliacao),
    justificativaConfianca: texto(p.justificativaConfianca),
    estrategiaRecomendada: semExpressoesAbsolutas(texto(p.estrategiaRecomendada)),
    medidaProcessualSugerida: texto(p.medidaProcessualSugerida),
    justificativaMedida: texto(p.justificativaMedida),
    peticao: texto(p.peticao),
    // O aviso legal é sempre o texto oficial, nunca o que a IA escrever.
    avisoLegal: AVISO_LEGAL_ANALISE,
    // Preenchida logo abaixo, pela verificação determinística.
    verificacaoTemporal: {
      dataAnalise: "",
      dataConsumacao: null,
      situacaoPrazo: "indeterminado",
      corrigido: false,
      resultadoOriginalIA: null,
      inconsistencias: [],
      memoriaCalculo: [],
    },
  };

  // -------------------------------------------------------------------------
  // TRAVA TEMPORAL (validações obrigatórias). Roda ANTES da trava da petição,
  // porque pode trocar o resultado — e a peça segue o resultado corrigido.
  // "Consumada" com data futura vira "não consumada"; "consumada" sem data ou
  // sem marco documental vira "inconclusiva". Aritmética não se terceiriza à IA.
  // -------------------------------------------------------------------------
  const coerencia = verificarCoerenciaTemporal(
    {
      resultado: analise.resultado,
      marcoInicial: analise.calculoPrazo.marcoInicial,
      dataProvavelConsumacao: analise.calculoPrazo.dataProvavelConsumacao,
      marcoFinal: analise.calculoPrazo.marcoFinal,
    },
    tipoAnalise,
    agora,
  );
  analise.verificacaoTemporal = coerencia.verificacao;

  if (coerencia.verificacao.corrigido) {
    const eraInconclusivo = resultado === "inconclusivo";
    analise.resultado = coerencia.resultadoFinal;
    // A conclusão textual da IA sustentava o resultado anterior; fica a
    // conclusão coerente com as datas, e o texto original é preservado nos
    // riscos (na reclassificação a leitura da IA segue útil e vai para os
    // pontos de avaliação, não para os riscos).
    analise.riscos = [
      ...coerencia.verificacao.inconsistencias,
      ...(eraInconclusivo ? [] : [`Conclusão textual original da IA (substituída): ${analise.conclusao.slice(0, 400)}`]),
      ...analise.riscos,
    ];
    if (eraInconclusivo) {
      analise.pontosParaAvaliacao = [
        `Leitura original da análise (antes da reclassificação): ${analise.conclusao.slice(0, 400)}`,
        ...analise.pontosParaAvaliacao,
      ];
    }

    const consumacaoBR = coerencia.verificacao.dataConsumacao
      ? coerencia.verificacao.dataConsumacao.split("-").reverse().join("/")
      : analise.calculoPrazo.dataProvavelConsumacao;

    analise.conclusao =
      coerencia.resultadoFinal === "negativo"
        ? eraInconclusivo
          ? `Há marco inicial documentado (${analise.calculoPrazo.marcoInicial}). A contagem legal indica consumação ` +
            `em ${consumacaoBR}, posterior à data da análise: o prazo está em andamento e a prescrição ainda não está ` +
            `consumada. Permanecem pendências documentais, registradas nos pontos para avaliação, que podem revelar ` +
            `marco anterior; sua confirmação exige os documentos complementares indicados.`
          : `A data provável de consumação (${consumacaoBR}) é posterior à data da análise. ` +
            `O prazo está em andamento e a tese ainda não pode ser afirmada como consumada. ` +
            `A conclusão foi ajustada automaticamente pela verificação de datas do sistema.`
        : `Não foi possível confirmar a consumação do prazo: o cálculo apresentado não traz marco inicial ou data de ` +
          `consumação verificáveis. Ausência de documento não gera presunção favorável; obtenha os documentos ` +
          `complementares indicados e realize nova análise.`;
    // O grau de consistência acompanha: uma resposta que precisou de correção
    // aritmética não sustenta consistência alta.
    if (analise.grauConsistencia === "alta") analise.grauConsistencia = "moderada";
  } else if (coerencia.verificacao.inconsistencias.length > 0) {
    analise.riscos = [...coerencia.verificacao.inconsistencias, ...analise.riscos];
  }

  // "Não consumada" exige fundamento: ou marco documentado com contagem em
  // andamento (classificação B), ou ato obstativo apontado. Negativo SEM marco
  // parseável e SEM obstativo é palpite, não conclusão — pela própria régua da
  // especificação, reclassifica-se como inconclusivo (nunca como positivo).
  if (
    analise.resultado === "negativo" &&
    !extrairData(analise.calculoPrazo.marcoInicial) &&
    !analise.verificacaoTemporal.dataConsumacao &&
    !analise.linhaDoTempo.some((e) => CLASSIFICACOES_OBSTATIVAS.has(e.classificacao))
  ) {
    analise.resultado = "inconclusivo";
    analise.verificacaoTemporal = {
      ...analise.verificacaoTemporal,
      corrigido: true,
      resultadoOriginalIA: "não consumada (NÃO)",
      inconsistencias: [
        ...analise.verificacaoTemporal.inconsistencias,
        "A resposta negativa não indicou marco inicial verificável nem ato obstativo: sem fundamento documental, " +
          "a negativa é palpite e foi reclassificada como inconclusiva.",
      ],
    };
    analise.riscos = [
      "Resposta negativa sem marco inicial verificável e sem ato obstativo apontado; reclassificada como inconclusiva.",
      ...analise.riscos,
    ];
  }

  // A justificativa do grau de confiança é obrigatória (bloco 11). Se a IA a
  // omitir, compõe-se uma factual, derivada dos números da própria análise, em
  // vez de deixar a classificação sem explicação.
  if (!analise.justificativaConfianca) {
    const usados = analise.documentosUtilizados.length;
    const ausentes = analise.documentosAusentes.length;
    analise.justificativaConfianca =
      `Classificação atribuída pela completude dos documentos (${usados} ${usados === 1 ? "utilizado" : "utilizados"}, ` +
      `${ausentes} ${ausentes === 1 ? "ausente" : "ausentes"}) e pela consistência das informações extraídas.`;
  }
  if (coerencia.verificacao.corrigido) {
    analise.justificativaConfianca +=
      " A verificação temporal do sistema corrigiu a conclusão original, o que reduz a confiança na extração de datas.";
  }

  // TRAVA CENTRAL: sem resultado positivo não existe peça, ainda que a IA
  // insista em mandar uma. Também some a medida sugerida, que só faz sentido
  // acompanhando a petição. A ESTRATÉGIA fica: orientação prática existe em
  // qualquer resultado (diligenciar documento, não protocolar, aguardar prazo).
  if (analise.resultado !== "positivo") {
    analise.peticao = "";
    analise.medidaProcessualSugerida = "";
    analise.justificativaMedida = "";
  }

  // Estratégia processual CONDICIONADA ao resultado (item 10 da especificação).
  // Nos resultados não positivos ela é imposta pelo sistema: a estratégia que a
  // IA escreveu acompanhava o resultado antigo e recomendaria a peça errada.
  if (analise.resultado === "negativo") {
    analise.estrategiaRecomendada =
      analise.tipoAnalise === "prescricao_intercorrente"
        ? "Não recomendar, neste momento, exceção de pré-executividade fundada exclusivamente em prescrição intercorrente. " +
          "Acompanhar o curso do prazo e reavaliar diante de novos atos processuais."
        : "Não recomendar, neste momento, medida fundada exclusivamente na tese analisada. " +
          "Acompanhar o processo e reavaliar diante de novos atos.";
  } else if (analise.resultado === "inconclusivo") {
    analise.estrategiaRecomendada = "Obter documentos complementares antes da adoção de medida judicial.";
  } else if (!analise.estrategiaRecomendada) {
    analise.estrategiaRecomendada =
      "Avaliar a apresentação de exceção de pré-executividade, desde que todos os fatos estejam demonstrados por " +
      "prova pré-constituída e não seja necessária dilação probatória.";
  }

  return analise;
}

/** A análise gera peça? Fonte única para servidor e interface. */
export function geraPeticao(a: AnaliseDirigida): boolean {
  return a.resultado === "positivo" && a.peticao.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Coerência inversa: "NÃO" com a conta dizendo que o prazo já venceu
// ---------------------------------------------------------------------------

/** Classificações de evento que obstam a consumação quando posteriores ao marco. */
const CLASSIFICACOES_OBSTATIVAS = new Set([
  "citacao",
  "penhora",
  "bloqueio",
  "parcelamento",
  "pagamento",
  "garantia",
]);

/** Há ato obstativo datado DEPOIS da referência? */
function temObstativoApos(a: AnaliseDirigida, referencia: Date): boolean {
  return a.linhaDoTempo.some((e) => {
    if (!CLASSIFICACOES_OBSTATIVAS.has(e.classificacao)) return false;
    const dataEvento = extrairData(e.data);
    return dataEvento !== null && dataEvento.getTime() > referencia.getTime();
  });
}

/**
 * Existe, na linha do tempo, ato APÓS o marco capaz de obstar a consumação
 * (citação válida, constrição efetiva, parcelamento, pagamento, garantia)?
 * Evento sem data parseável não conta: obstáculo sem data não sustenta um "NÃO".
 */
export function temCausaObstativaAposMarco(a: AnaliseDirigida): boolean {
  const marco = extrairData(a.calculoPrazo.marcoInicial);
  if (!marco) return false;
  return temObstativoApos(a, marco);
}

/**
 * Classificações de evento que podem constituir marco inicial da contagem.
 * "certidao" entra porque certidões de intimação/decurso carregam a data em que
 * a intimação começou; o falso positivo eventual só custa um confronto a mais
 * com o modelo, enquanto o falso negativo deixa passar um marco vencido.
 */
const CLASSIFICACOES_MARCO = new Set([
  "intimacao-fazenda",
  "ciencia-fazenda",
  "inercia",
  "mera-intimacao",
  "mera-movimentacao",
  "arquivamento",
  "suspensao",
  "certidao",
]);

export interface MarcoAlternativoVencido {
  data: string;
  pagina: string;
  evento: string;
  consumacaoCalculada: string;
}

/**
 * Marcos ANTERIORES ao adotado cuja contagem já teria vencido, sem ato
 * obstativo posterior. É o caso real do IPTU municipal: intimação da
 * Fazenda em 17/12/2018 com inércia certificada nos autos e nenhuma diligência
 * patrimonial depois, mas a IA adotou como marco a decisão formal de 2023 e
 * respondeu "não consumada". O servidor detecta o marco potencial vencido e
 * confronta o modelo com ele; a decisão jurídica continua sendo da análise, mas
 * ignorar o marco deixa de ser possível.
 */
export function marcosAlternativosVencidos(
  a: AnaliseDirigida,
  agora: Date = new Date(),
): MarcoAlternativoVencido[] {
  const anos = a.tipoAnalise === "prescricao_intercorrente" ? 6 : 5;
  const marcoAtual = extrairData(a.calculoPrazo.marcoInicial);

  const candidatos: Array<{ d: Date; e: (typeof a.linhaDoTempo)[number] }> = [];
  for (const e of a.linhaDoTempo) {
    if (!CLASSIFICACOES_MARCO.has(e.classificacao)) continue;
    const d = extrairData(e.data);
    if (!d) continue;
    // Só interessa marco ANTERIOR ao adotado (senão é o próprio) e cuja
    // contagem já tenha vencido na data da análise.
    if (marcoAtual && d.getTime() >= marcoAtual.getTime()) continue;
    const consumacao = somarAnos(d, anos);
    if (consumacao.getTime() > agora.getTime()) continue;
    if (temObstativoApos(a, d)) continue;
    candidatos.push({ d, e });
  }

  candidatos.sort((x, y) => x.d.getTime() - y.d.getTime());
  return candidatos.slice(0, 3).map(({ d, e }) => ({
    data: formatarBR(d),
    pagina: e.pagina || "-",
    evento: e.evento,
    consumacaoCalculada: formatarBR(somarAnos(d, anos)),
  }));
}

/**
 * A análise respondeu "não consumada" enquanto a própria aritmética diz que o
 * prazo já venceu, sem nenhum ato obstativo posterior ao marco que explique a
 * negativa? É a contradição INVERSA da trava principal: um "NÃO" indevido nega
 * ao cliente uma tese que os autos sustentam. Caso real: execução de 2009
 * com marco em 23/05/2013, consumação calculada para 2018 e resposta "NÃO"
 * porque o processo estaria "dentro do período de suspensão" treze anos depois.
 */
export function contradizDatasNegativo(a: AnaliseDirigida): boolean {
  return (
    a.resultado === "negativo" &&
    a.verificacaoTemporal.situacaoPrazo === "consumado" &&
    !temCausaObstativaAposMarco(a)
  );
}

/**
 * Inconclusivo com o marco DOCUMENTADO e a contagem já vencida, sem ato
 * obstativo posterior. É a hesitação que a regra simétrica não admite: ou
 * existe documento que impeça a consumação, ou o prazo venceu. Devolve a data
 * de consumação calculada (BR) quando o caso se configura; null caso contrário.
 */
export function inconclusivoComContagemVencida(a: AnaliseDirigida, agora: Date = new Date()): string | null {
  if (a.resultado !== "inconclusivo") return null;
  const marco = extrairData(a.calculoPrazo.marcoInicial);
  if (!marco) return null;
  const anos = a.tipoAnalise === "prescricao_intercorrente" ? 6 : 5;
  const consumacao = somarAnos(marco, anos);
  if (consumacao.getTime() > agora.getTime()) return null;
  if (temObstativoApos(a, marco)) return null;
  return formatarBR(consumacao);
}

/**
 * Rebaixa para inconclusivo um "NÃO" que persiste em contradizer as datas.
 *
 * NUNCA promove a "consumada" por conta própria: afirmar a tese é ato de
 * convencimento jurídico, não de aritmética. Mas um "NÃO" sereno também não
 * pode ficar de pé quando a conta o desmente: o rebaixamento força a revisão
 * humana com a contradição exposta em vermelho.
 */
export function rebaixarNegativoContraditorio(a: AnaliseDirigida): AnaliseDirigida {
  const consumacaoBR = a.verificacaoTemporal.dataConsumacao
    ? a.verificacaoTemporal.dataConsumacao.split("-").reverse().join("/")
    : a.calculoPrazo.dataProvavelConsumacao;

  return {
    ...a,
    resultado: "inconclusivo",
    grauConsistencia: "baixa",
    conclusao:
      `A contagem a partir do marco documentado (${a.calculoPrazo.marcoInicial}) indica consumação em ${consumacaoBR}, ` +
      `data já vencida, e a análise não apontou ato interruptivo ou suspensivo posterior ao marco que impeça a ` +
      `consumação. A resposta negativa da IA é incompatível com esse quadro e foi rebaixada: revise os autos com ` +
      `atenção aos atos posteriores ao marco antes de concluir.`,
    estrategiaRecomendada: "Obter documentos complementares antes da adoção de medida judicial.",
    riscos: [
      `Contradição não resolvida: a IA manteve resposta negativa com a consumação calculada para ${consumacaoBR} ` +
        `(já vencida) e sem ato obstativo posterior ao marco. O resultado foi rebaixado para inconclusivo por segurança.`,
      ...a.riscos,
    ],
    verificacaoTemporal: {
      ...a.verificacaoTemporal,
      corrigido: true,
      resultadoOriginalIA: "não consumada (NÃO)",
    },
  };
}
