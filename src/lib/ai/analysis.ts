import { prisma } from "../db";
import { env } from "../env";
import { callLLM, isAiConfigured, activeModel, extractJson } from "./provider";
import { SISTEMA_ANALISE_V2, AVISO_RESPONSABILIDADE } from "./prompts";
import { instrucoesDaMateria, AVISO_LEGAL_ANALISE } from "./prompts-materia";
import { materiaPorSlug, type MateriaSlug } from "./materias";
import { selecionarPaginas } from "../legal/selecao-paginas";
import { montarChecklist } from "../legal/checklist-documentos";
import { detectarEventosChave, formatarEventosChave, candidatosMarcoVencidos } from "../legal/deteccao-eventos";
import {
  sanearResultado,
  rotuloConclusao,
  contradizDatasNegativo,
  rebaixarNegativoContraditorio,
  marcosAlternativosVencidos,
  inconclusivoComContagemVencida,
  GRAU_CONFIANCA,
  NAO_LOCALIZADO,
  type AnaliseDirigida,
  type ResultadoAnalise,
} from "./analise-dirigida";
import {
  analisarDecadencia,
  analisarPrescricaoOrdinaria,
  analisarPrescricaoIntercorrente,
  analisarPrescricaoRedirecionamento,
  fmt,
} from "../legal/prescricao";

/**
 * Motor de análise da plataforma:
 * a entrega principal é a EXCEÇÃO DE PRÉ-EXECUTIVIDADE (EPE), no formato de
 * 4 seções (conclusão direta -> quadro dos institutos -> linha do tempo -> peça).
 *
 * Combina: prompt de sistema ATIVO (banco/fallback) + base de conhecimento ATIVA
 * (injetada no contexto) + IA. Sem chave de IA, usa modo heurístico auditável
 * (cálculos determinísticos), sem inventar dados.
 */

export type Resultado = "SIM" | "NÃO" | "INDETERMINADO";
export type Confianca = "ALTO" | "MEDIO" | "BAIXO" | "INDETERMINADO";

export interface InstitutoRow {
  instituto: string;
  resultado: Resultado;
  motivo: string;
  fundamento?: string | null;
  prazoFinal?: string | null;
}

export interface TimelineItem {
  dateText?: string | null;
  eventDate?: string | null;
  type: string;
  nature: string;
  description: string;
  legalEffect?: string | null;
  sourceRef?: string | null;
  sourcePage?: number | null;
}

export interface AnalysisResultData {
  mode: "ia" | "heuristico";
  /** Presente quando a análise foi dirigida a uma matéria escolhida. */
  dirigida?: AnaliseDirigida;
  parties: { creditor?: string | null; debtor?: string | null; processNumber?: string | null };
  conclusaoDirecta: string;
  quadro: InstitutoRow[];
  tesePrincipal: string;
  tesesSubsidiarias: string[];
  cabimentoEPE: Resultado;
  timeline: TimelineItem[];
  documentosFaltantes: string[];
  epe: { titulo: "PRONTA" | "CONDICIONADA" | "NAO_RECOMENDADA"; markdown: string };
  confidence: Confianca;
}

/** Carrega o prompt ativo do tipo informado, com fallback ao default embutido. */
async function activePrompt(kind: string, fallback: string): Promise<{ id: string | null; content: string }> {
  try {
    const p = await prisma.promptVersion.findFirst({ where: { kind: kind as never, active: true }, orderBy: { version: "desc" } });
    if (p) return { id: p.id, content: p.content };
  } catch {
    /* banco indisponível — usa fallback */
  }
  return { id: null, content: fallback };
}

/**
 * Carrega a base de conhecimento ativa para injeção no contexto.
 *
 * Duas regras vieram de um defeito real: a versão anterior ordenava por
 * categoria e dava `break` no primeiro documento que não coubesse no teto —
 * descartava o documento INTEIRO e todos os seguintes. Com a base da EPE
 * (37.864 car.) vindo antes, a referência de legislação e súmulas (13.636)
 * era silenciosamente jogada fora justamente nas análises mais longas.
 *
 * Agora: (1) do menor para o maior, para que as referências compactas — que
 * sustentam a CONCLUSÃO — sempre entrem, e o material extenso de modelo de
 * peça absorva o corte; (2) o último documento é truncado com aviso, em vez
 * de sumir, para a IA saber que aquela fonte veio incompleta.
 */
async function activeKnowledge(maxChars = env.ai.maxKnowledgeChars): Promise<string> {
  try {
    const docs = await prisma.knowledgeDocument.findMany({
      where: { active: true, content: { not: null } },
      select: { title: true, content: true },
    });

    const ordenados = docs
      .map((d) => ({ title: d.title, content: d.content ?? "" }))
      .filter((d) => d.content.length > 0)
      .sort((a, b) => a.content.length - b.content.length);

    let out = "";
    for (const d of ordenados) {
      const cabecalho = `\n\n===== ${d.title} =====\n`;
      const restante = maxChars - out.length - cabecalho.length;
      if (restante <= 0) break;
      if (d.content.length <= restante) {
        out += cabecalho + d.content;
        continue;
      }
      // Não cabe inteiro: entra o que couber, com aviso explícito.
      const aviso = `\n[...documento truncado: ${d.content.length} caracteres no original]`;
      if (restante > aviso.length + 500) {
        out += cabecalho + d.content.slice(0, restante - aviso.length) + aviso;
      }
      break;
    }
    return out;
  } catch {
    return "";
  }
}

interface RunInput {
  analysis: {
    id: string;
    title: string;
    type: string;
    objective?: string | null;
    processNumber?: string | null;
    court?: string | null;
    creditor?: string | null;
    debtor?: string | null;
    taxType?: string | null;
    facts?: Record<string, unknown> | null;
  };
  documentsText: { filename: string; pages: { page: number; text: string }[] }[];
  /** Matéria escolhida pelo cliente. Presente = análise dirigida. */
  materia?: MateriaSlug | null;
}

export async function runAnalysis(input: RunInput): Promise<{
  data: AnalysisResultData;
  promptVersionId: string | null;
  model: string;
  usage?: { input?: number; output?: number };
}> {
  if (!isAiConfigured()) {
    return { data: comDirigida(runHeuristic(input), input), promptVersionId: null, model: "heuristico-local" };
  }
  try {
    return input.materia ? await runDirigida(input, input.materia) : await runWithAI(input);
  } catch (err) {
    // Indisponibilidade da IA (401, 429, timeout, crédito esgotado) NÃO pode
    // derrubar a análise: o cliente recebe o resultado heurístico, marcado como
    // tal, e o erro fica registrado para o administrador.
    console.error("[analise] IA indisponível, caindo para modo heurístico:", (err as Error).message);
    const data = comDirigida(runHeuristic(input), input);
    data.conclusaoDirecta = `⚠️ A IA não pôde ser consultada (${(err as Error).message.slice(0, 120)}). ${data.conclusaoDirecta}`;
    return { data, promptVersionId: null, model: "heuristico-local (falha da IA)" };
  }
}

/**
 * Análise dirigida a uma matéria: prompt aprovado + base de conhecimento ativa
 * + instruções específicas do instituto escolhido.
 */
async function runDirigida(input: RunInput, materia: MateriaSlug) {
  const sistema = await activePrompt("SISTEMA_ANALISE", SISTEMA_ANALISE_V2);
  const knowledge = await activeKnowledge();
  const m = materiaPorSlug(materia);

  // Checklist determinístico sobre o texto COMPLETO (não o corpus truncado):
  // um documento presente na página 300 continua presente ainda que a página
  // não caiba no orçamento de tokens da IA.
  const textoCompleto = input.documentsText.flatMap((d) => d.pages.map((p) => p.text)).join("\n");
  const checklist = montarChecklist(materia, textoCompleto);

  // Varredura determinística de eventos-chave: intimações, certidões de
  // inércia, suspensões, constrições, parcelamentos. A lista vai no prompt com
  // página e datas, e a IA é obrigada a incorporar (ou refutar) cada item —
  // é o que impede a linha do tempo de "esquecer" o evento que define o marco.
  const eventosChave = detectarEventosChave(input.documentsText.flatMap((d) => d.pages));

  const system = [
    sistema.content,
    `\n=== BASE DE CONHECIMENTO (fonte primária e vinculante) ===${knowledge}`,
    `\n=== ANÁLISE DIRIGIDA ===\n${instrucoesDaMateria(materia, checklist)}`,
  ].join("\n");
  const user =
    `${buildCorpus(input)}${formatarEventosChave(eventosChave)}\n\n` +
    `MATÉRIA A ANALISAR: ${m.label} (${m.resumo})\nPERGUNTA A RESPONDER: ${m.pergunta}`;

  const res = await callLLM({ system, user, json: true });
  let dirigida = sanearResultado(extractJson<unknown>(res.text), materia);
  let usage = { input: res.inputTokens ?? 0, output: res.outputTokens ?? 0 };

  // ---------------------------------------------------------------------------
  // Coerência inversa. A trava temporal já impede "SIM" com data futura; aqui se
  // trata do erro oposto: "NÃO" com a consumação calculada JÁ VENCIDA e nenhum
  // ato obstativo posterior ao marco. Nesse caso o modelo ganha UMA segunda
  // chance, com a aritmética do sistema na frente — ou aponta o ato concreto
  // que impede a consumação, ou refaz a conclusão. Caso real: execução
  // de 2009 respondida como "NÃO" com consumação em 2018.
  // ---------------------------------------------------------------------------
  if (contradizDatasNegativo(dirigida)) {
    const correcao = [
      "REVISÃO OBRIGATÓRIA DA SUA RESPOSTA ANTERIOR.",
      "A conclusão anterior não confere com a contagem do sistema a partir do marco que você adotou:",
      ...dirigida.verificacaoTemporal.memoriaCalculo.map((l) => `- ${l}`),
      "",
      "Revise a conclusão e devolva o JSON completo corrigido, apontando com data e página qualquer ato que a justifique.",
    ].join("\n");

    const res2 = await callLLM({
      system,
      user: `${user}\n\n=== SUA RESPOSTA ANTERIOR ===\n${res.text.slice(0, 6000)}\n\n=== ${correcao}`,
      json: true,
    });
    usage = { input: usage.input + (res2.inputTokens ?? 0), output: usage.output + (res2.outputTokens ?? 0) };
    const segunda = sanearResultado(extractJson<unknown>(res2.text), materia);

    // Se a segunda resposta AINDA contradiz as datas, nenhum "NÃO" sereno fica
    // de pé: rebaixa para inconclusivo com a contradição exposta em vermelho.
    dirigida = contradizDatasNegativo(segunda) ? rebaixarNegativoContraditorio(segunda) : segunda;
  } else if (inconclusivoComContagemVencida(dirigida)) {
    // -------------------------------------------------------------------------
    // Hesitação com a conta vencida: "inconclusivo" com marco DOCUMENTADO cuja
    // contagem já venceu e sem obstativo posterior. É o espelho da contradição
    // do "NÃO": a regra simétrica não admite hesitar quando a aritmética
    // fechou. Caso real: IPTU com marco 13/12/2018 adotado pela própria IA
    // (consumação 13/12/2024) e resposta "inconclusiva" por falta das
    // pesquisas patrimoniais — que não existem justamente porque a Fazenda
    // nada requereu, o que é o fundamento da tese, não a lacuna dela.
    // -------------------------------------------------------------------------
    const consumacaoBR = inconclusivoComContagemVencida(dirigida)!;
    const correcao = [
      "REVISÃO OBRIGATÓRIA DA SUA RESPOSTA ANTERIOR.",
      `A contagem do sistema a partir do marco "${dirigida.calculoPrazo.marcoInicial}" resulta em ${consumacaoBR}.`,
      "Revise a conclusão e devolva o JSON completo corrigido, apontando com data e página qualquer ato que a justifique.",
    ].join("\n");

    const resB = await callLLM({
      system,
      user: `${user}\n\n=== SUA RESPOSTA ANTERIOR ===\n${res.text.slice(0, 6000)}\n\n=== ${correcao}`,
      json: true,
    });
    usage = { input: usage.input + (resB.inputTokens ?? 0), output: usage.output + (resB.outputTokens ?? 0) };
    const segundaB = sanearResultado(extractJson<unknown>(resB.text), materia);
    if (contradizDatasNegativo(segundaB)) {
      dirigida = rebaixarNegativoContraditorio(segundaB);
    } else {
      dirigida = segundaB;
      if (dirigida.resultado === "inconclusivo") {
        dirigida.riscos = [
          `Atenção: o marco adotado pela análise (${dirigida.calculoPrazo.marcoInicial}) tem contagem já vencida e ` +
            `nenhum ato obstativo posterior foi apontado, mas a IA manteve a resposta inconclusiva. Conferir na revisão.`,
          ...dirigida.riscos,
        ];
      }
    }
  } else if (dirigida.resultado !== "positivo") {
    // -------------------------------------------------------------------------
    // Marco alternativo vencido. A resposta não contradiz o marco que ELA
    // adotou, mas há marco ANTERIOR (intimação não atendida, ciência,
    // arquivamento) cuja contagem já venceu, sem ato obstativo posterior.
    //
    // Os candidatos vêm de DUAS fontes, de propósito: a linha do tempo da IA e
    // o DETECTOR determinístico sobre as páginas. A segunda é a que importa —
    // no caso real do IPTU o modelo omitia a intimação de 17/12/2018 da linha
    // do tempo em rodada sim, rodada não, e o confronto baseado só nela nunca
    // disparava. O detector lê o texto: o candidato existe sempre que a página
    // o contém, independentemente do humor do modelo.
    // -------------------------------------------------------------------------
    const daIA = marcosAlternativosVencidos(dirigida).map((m) => ({
      data: m.data,
      origem: `${m.evento}, ${m.pagina}`,
      consumacao: m.consumacaoCalculada,
    }));
    const doDetector = candidatosMarcoVencidos(eventosChave, materia).map((c) => ({
      data: c.data,
      origem: `${c.descricao}, p.${c.pagina}`,
      consumacao: c.consumacaoCalculada,
    }));
    const vistos = new Set<string>();
    const alternativos = [...doDetector, ...daIA].filter((m) => {
      if (vistos.has(m.data)) return false;
      vistos.add(m.data);
      return true;
    });
    if (alternativos.length > 0) {
      const lista = alternativos
        .map((m) => `- ${m.data} (${m.origem}): contagem venceria em ${m.consumacao}`)
        .join("\n");
      const correcao = [
        "REVISÃO OBRIGATÓRIA DA SUA RESPOSTA ANTERIOR.",
        "Há marcos anteriores ao adotado cuja contagem o sistema calculou:",
        lista,
        "",
        "Avalie esses marcos e devolva o JSON completo corrigido, com data e página de cada ato considerado.",
      ].join("\n");

      const res3 = await callLLM({
        system,
        user: `${user}\n\n=== SUA RESPOSTA ANTERIOR ===\n${res.text.slice(0, 6000)}\n\n=== ${correcao}`,
        json: true,
      });
      usage = { input: usage.input + (res3.inputTokens ?? 0), output: usage.output + (res3.outputTokens ?? 0) };
      const terceira = sanearResultado(extractJson<unknown>(res3.text), materia);

      // A resposta do confronto vale se não criou contradição nova; caso
      // contrário, o marco ignorado vira risco em vermelho na resposta original.
      if (!contradizDatasNegativo(terceira)) {
        dirigida = terceira;
        if (dirigida.resultado !== "positivo") {
          dirigida.riscos = [
            `Atenção: os autos registram marco potencial anterior já vencido (${alternativos[0]!.data}, ` +
              `${alternativos[0]!.origem}) e a análise manteve a conclusão de não consumação. Conferir na revisão.`,
            ...dirigida.riscos,
          ];
        }
      } else {
        dirigida = rebaixarNegativoContraditorio(terceira);
      }
    }
  }

  return {
    data: paraResultado(dirigida, "ia", input),
    promptVersionId: sistema.id,
    model: res.model || activeModel(),
    usage,
  };
}

/** Converte a análise dirigida no formato que relatório, exportação e tela consomem. */
function paraResultado(d: AnaliseDirigida, mode: "ia" | "heuristico", input: RunInput): AnalysisResultData {
  const CONF: Record<string, Confianca> = { alta: "ALTO", moderada: "MEDIO", baixa: "BAIXO" };
  return {
    mode,
    dirigida: d,
    parties: {
      creditor: input.analysis.creditor ?? null,
      debtor: input.analysis.debtor ?? null,
      processNumber: input.analysis.processNumber ?? null,
    },
    conclusaoDirecta: `${rotuloConclusao(d.tipoAnalise, d.resultado)}\n\n${d.conclusao}`,
    quadro: [
      {
        instituto: materiaPorSlug(d.tipoAnalise).label,
        resultado: d.resultado === "positivo" ? "SIM" : d.resultado === "negativo" ? "NÃO" : "INDETERMINADO",
        motivo: d.resumoExecutivo || d.conclusao,
        prazoFinal: d.calculoPrazo.dataProvavelConsumacao || null,
      },
    ],
    tesePrincipal: materiaPorSlug(d.tipoAnalise).label,
    tesesSubsidiarias: [],
    cabimentoEPE: d.resultado === "positivo" ? "SIM" : d.resultado === "negativo" ? "NÃO" : "INDETERMINADO",
    timeline: d.linhaDoTempo.map((e) => ({
      dateText: e.data,
      eventDate: /^\d{4}-\d{2}-\d{2}$/.test(e.data) ? e.data : null,
      type: "SEM_EFEITO_DEFINIDO",
      // Evento lido de documento por IA é INTERPRETACAO, não fato confirmado.
      nature: mode === "ia" ? "INTERPRETACAO" : "FATO_CONFIRMADO",
      description: e.evento,
      legalEffect: e.efeitoJuridico || null,
      sourcePage: paginaNumerica(e.pagina),
    })),
    documentosFaltantes: d.documentosAusentes,
    epe: {
      titulo: d.resultado === "positivo" ? "PRONTA" : "NAO_RECOMENDADA",
      markdown: d.peticao,
    },
    confidence: CONF[d.grauConsistencia] ?? "INDETERMINADO",
  };
}

/** "215" ou "Página 215 do PDF" → 215; sem número reconhecível → null. */
function paginaNumerica(v: string): number | null {
  const m = /\d+/.exec(v ?? "");
  return m?.[0] ? Number(m[0]) : null;
}

/** Instituto do quadro heurístico correspondente a cada matéria. */
const INSTITUTO_DA_MATERIA: Record<MateriaSlug, string> = {
  prescricao_intercorrente: "Prescrição intercorrente",
  prescricao_ordinaria: "Prescrição ordinária",
  decadencia_tributaria: "Decadência",
};

/**
 * Sem IA, monta a análise dirigida a partir do cálculo determinístico do motor
 * jurídico. O resultado é honesto quanto ao seu alcance: a consistência é
 * sempre BAIXA, porque o modo heurístico não lê o documento — trabalha só com
 * as datas que a extração conseguiu identificar.
 */
function comDirigida(base: AnalysisResultData, input: RunInput): AnalysisResultData {
  const materia = input.materia;
  if (!materia) return base;

  const linha = base.quadro.find((q) => q.instituto === INSTITUTO_DA_MATERIA[materia]);
  const resultado: ResultadoAnalise =
    linha?.resultado === "SIM" ? "positivo" : linha?.resultado === "NÃO" ? "negativo" : "inconclusivo";

  const m = materiaPorSlug(materia);
  const dirigida: AnaliseDirigida = {
    tipoAnalise: materia,
    resultado,
    grauConsistencia: "baixa",
    // Sem repetir o rótulo: a tela já o exibe como título do bloco.
    conclusao:
      `Apuração em modo heurístico (sem IA), a partir apenas das datas identificadas no documento. ` +
      `${linha?.motivo ?? NAO_LOCALIZADO} Revisão por advogado(a) obrigatória.`,
    resumoExecutivo:
      `Análise de ${m.label.toLowerCase()} sobre ${input.analysis.processNumber ?? "processo sem número identificado"}. ` +
      `O modo heurístico aplica o cálculo de prazo previsto em lei às datas encontradas; não interpreta o conteúdo das peças.`,
    linhaDoTempo: base.timeline.map((t) => ({
      data: t.dateText ?? t.eventDate ?? NAO_LOCALIZADO,
      evento: t.description,
      pagina: "",
      classificacao: "",
      efeitoJuridico: t.legalEffect ?? "",
      relevancia: "media" as const,
      // Dado informado pelo cliente, não extraído do documento: confiança baixa.
      confianca: "baixa" as const,
    })),
    calculoPrazo: {
      marcoInicial: NAO_LOCALIZADO,
      prazoAplicavel: m.resumo,
      periodosSuspensao: [],
      atosInterruptivos: [],
      marcoFinal: linha?.prazoFinal ?? NAO_LOCALIZADO,
      dataProvavelConsumacao: linha?.prazoFinal ?? NAO_LOCALIZADO,
      explicacao: linha?.motivo ?? NAO_LOCALIZADO,
    },
    fundamentacaoLegal: [m.resumo],
    precedentes: [],
    elementosFavoraveis: resultado === "positivo" && linha?.motivo ? [linha.motivo] : [],
    riscos: ["Apuração sem leitura do inteiro teor: causas de suspensão ou interrupção registradas nas peças podem não ter sido consideradas."],
    documentosUtilizados: input.documentsText.map((d) => d.filename),
    documentosAusentes: base.documentosFaltantes,
    pontosParaAvaliacao: [],
    justificativaConfianca:
      "Grau baixo por definição do modo heurístico: o cálculo usa apenas as datas identificadas, sem leitura do inteiro teor das peças.",
    estrategiaRecomendada:
      resultado === "positivo"
        ? "Confirmar as datas nos autos e submeter a minuta à revisão do(a) advogado(a) antes do protocolo."
        : "Revisar os autos com o(a) advogado(a); o modo heurístico não lê o conteúdo das peças.",
    medidaProcessualSugerida: resultado === "positivo" ? "Exceção de Pré-Executividade" : "",
    justificativaMedida:
      resultado === "positivo"
        ? "Matéria de ordem pública, conhecível de ofício e comprovável de plano, dispensada a garantia do juízo (Súmula 393/STJ)."
        : "",
    peticao: resultado === "positivo" ? base.epe.markdown : "",
    avisoLegal: AVISO_LEGAL_ANALISE,
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

  // Passa pelo mesmo saneamento da resposta da IA, para que a trava da petição
  // E a verificação temporal valham também no caminho heurístico.
  return { ...paraResultado(sanearResultado(dirigida, materia), "heuristico", input), mode: "heuristico" };
}

async function runWithAI(input: RunInput) {
  const sistema = await activePrompt("SISTEMA_ANALISE", SISTEMA_ANALISE_V2);
  const knowledge = await activeKnowledge();
  const corpus = buildCorpus(input);

  const schemaHint = [
    "Retorne JSON EXCLUSIVAMENTE no formato:",
    "{",
    '  "conclusaoDirecta": string (máx. 10 linhas),',
    '  "grauConfianca": "ALTO"|"MEDIO"|"BAIXO",',
    '  "quadro": [{"instituto": "Decadência"|"Prescrição ordinária"|"Prescrição intercorrente"|"Prescrição do redirecionamento", "resultado": "SIM"|"NÃO"|"INDETERMINADO", "motivo": string}],',
    '  "tesePrincipal": string, "tesesSubsidiarias": string[],',
    '  "cabimentoEPE": "SIM"|"NÃO"|"INDETERMINADO",',
    '  "linhaDoTempo": [{"eventDate": "YYYY-MM-DD"|null, "dateText": string|null, "type": string, "nature": "FATO_CONFIRMADO"|"INTERPRETACAO"|"HIPOTESE"|"PENDENTE", "description": string, "legalEffect": string|null, "sourcePage": number|null}],',
    '  "documentosFaltantes": string[],',
    '  "epeTitulo": "PRONTA"|"CONDICIONADA"|"NAO_RECOMENDADA",',
    '  "epeMarkdown": string  // a Exceção de Pré-Executividade COMPLETA em markdown, com a fundamentação, o cálculo aritmético e os pedidos',
    "}",
  ].join("\n");

  const res = await callLLM({
    system: `${sistema.content}\n\n=== BASE DE CONHECIMENTO (fonte primária e vinculante) ===${knowledge}\n\n${schemaHint}`,
    user: corpus,
    json: true,
  });

  const parsed = extractJson<RawAI>(res.text);
  const data = normalize(parsed, "ia", input);
  return { data, promptVersionId: sistema.id, model: res.model || activeModel(), usage: { input: res.inputTokens, output: res.outputTokens } };
}

function buildCorpus(input: RunInput): string {
  const facts = input.analysis.facts ?? {};

  // O orçamento do provedor não comporta um processo inteiro. Em vez de cortar
  // pelos primeiros N caracteres — que entrega a petição inicial e esconde as
  // movimentações —, seleciona as páginas mais relevantes para a matéria.
  // Páginas com evento-chave detectado têm passe livre: a pontuação por termos
  // já descartou a certidão curta que definia o marco da contagem.
  const paginas = input.documentsText.flatMap((d) => d.pages.map((p) => ({ page: p.page, text: p.text })));
  const obrigatorias = new Set(detectarEventosChave(paginas).map((e) => e.pagina));
  const sel = selecionarPaginas(paginas, input.materia ?? null, env.ai.maxCorpusChars, obrigatorias);

  const docs = sel.truncado
    ? `${sel.texto}\n\n[SELEÇÃO PARCIAL: o processo tem ${paginas.length} páginas com texto; ${sel.paginasEnviadas.length} foram enviadas (as mais relevantes para esta matéria) e ${sel.paginasOmitidas} ficaram de fora por limite de tamanho. NÃO conclua pela ausência de um ato processual apenas por não o encontrar aqui — registre em documentosAusentes que parte do processo não foi analisada.]`
    : sel.texto;

  return [
    `TÍTULO: ${input.analysis.title}`,
    `TIPO DE ANÁLISE SOLICITADA: ${input.analysis.type} (analise SEMPRE os 3-4 institutos, não apenas este).`,
    input.analysis.objective ? `OBJETIVO: ${input.analysis.objective}` : "",
    `\nDADOS INFORMADOS PELO USUÁRIO (podem divergir dos documentos — sinalize divergências):\n${JSON.stringify({ ...input.analysis, facts }, null, 2)}`,
    `\nTEXTO DOS DOCUMENTOS ANEXADOS:\n${docs || "(nenhum texto extraído — analise os dados informados e aponte as ausências; produza EPE CONDICIONADA)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

interface RawAI {
  conclusaoDirecta?: string;
  grauConfianca?: string;
  quadro?: InstitutoRow[];
  tesePrincipal?: string;
  tesesSubsidiarias?: string[];
  cabimentoEPE?: Resultado;
  linhaDoTempo?: TimelineItem[];
  documentosFaltantes?: string[];
  epeTitulo?: "PRONTA" | "CONDICIONADA" | "NAO_RECOMENDADA";
  epeMarkdown?: string;
}

function normalize(p: RawAI | null, mode: "ia" | "heuristico", input: RunInput): AnalysisResultData {
  const conf = (p?.grauConfianca?.toUpperCase() as Confianca) || "INDETERMINADO";
  return {
    mode,
    parties: {
      creditor: input.analysis.creditor ?? null,
      debtor: input.analysis.debtor ?? null,
      processNumber: input.analysis.processNumber ?? null,
    },
    conclusaoDirecta: p?.conclusaoDirecta ?? "Análise concluída. Revisão por advogado(a) obrigatória.",
    quadro: p?.quadro?.length ? p.quadro : quadroVazio(),
    tesePrincipal: p?.tesePrincipal ?? "Indeterminada nos documentos analisados.",
    tesesSubsidiarias: p?.tesesSubsidiarias ?? [],
    cabimentoEPE: p?.cabimentoEPE ?? "INDETERMINADO",
    timeline: p?.linhaDoTempo ?? [],
    documentosFaltantes: p?.documentosFaltantes ?? [],
    epe: {
      titulo: p?.epeTitulo ?? "CONDICIONADA",
      markdown: p?.epeMarkdown ?? "Exceção de Pré-Executividade indisponível — dados insuficientes.",
    },
    confidence: ["ALTO", "MEDIO", "BAIXO", "INDETERMINADO"].includes(conf) ? conf : "INDETERMINADO",
  };
}

function quadroVazio(): InstitutoRow[] {
  return [
    { instituto: "Decadência", resultado: "INDETERMINADO", motivo: "Dados insuficientes." },
    { instituto: "Prescrição ordinária", resultado: "INDETERMINADO", motivo: "Dados insuficientes." },
    { instituto: "Prescrição intercorrente", resultado: "INDETERMINADO", motivo: "Dados insuficientes." },
  ];
}

/** Modo heurístico local: cálculos determinísticos sobre os dados informados. */
function runHeuristic(input: RunInput): AnalysisResultData {
  const f = (input.analysis.facts ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
  const b = (k: string) => f[k] === true;

  const dec = analisarDecadencia({ dataFatoGerador: s("dataFatoGerador"), dataConstituicaoDefinitiva: s("dataConstituicaoDefinitiva") });
  const ord = analisarPrescricaoOrdinaria({
    dataConstituicaoDefinitiva: s("dataConstituicaoDefinitiva"),
    dataDespachoCitatorio: s("dataDespachoCitatorio"),
    dataAjuizamento: s("dataAjuizamento"),
    dataCitacao: s("dataCitacao"),
    houveParcelamento: b("possuiParcelamento"),
    dataInicioParcelamento: s("periodoParcelamento"),
  });
  const inter = analisarPrescricaoIntercorrente({
    dataCitacaoOuNaoLocalizacao: s("dataCitacao"),
    houveCausaInterrupcaoAposArquivamento: b("possuiPenhora"),
  });
  // 4º instituto — só quando há sócio/redirecionamento informado.
  const redir = b("possuiRedirecionamento")
    ? analisarPrescricaoRedirecionamento({
        dataCitacaoPJ: s("dataCitacaoPJ"),
        dataAtoIlicito: s("dataDissolucaoIrregular"),
        dataPedidoRedirecionamento: s("dataPedidoRedirecionamento"),
        fazendaInerte: b("fazendaInerteRedirecionamento"),
      })
    : null;

  const toRes = (ocorrido: boolean | null): Resultado => (ocorrido === null ? "INDETERMINADO" : ocorrido ? "SIM" : "NÃO");
  const quadro: InstitutoRow[] = [
    { instituto: "Decadência", resultado: toRes(dec.ocorrido), motivo: dec.fundamento, prazoFinal: dec.prazoFinal ? fmt(dec.prazoFinal) : null },
    { instituto: "Prescrição ordinária", resultado: toRes(ord.ocorrido), motivo: ord.fundamento, prazoFinal: ord.prazoFinal ? fmt(ord.prazoFinal) : null },
    { instituto: "Prescrição intercorrente", resultado: toRes(inter.ocorrido), motivo: inter.fundamento, prazoFinal: inter.prazoFinal ? fmt(inter.prazoFinal) : null },
  ];
  if (redir) {
    quadro.push({ instituto: "Prescrição do redirecionamento", resultado: toRes(redir.ocorrido), motivo: redir.fundamento, prazoFinal: redir.prazoFinal ? fmt(redir.prazoFinal) : null });
  }

  const timeline: TimelineItem[] = [];
  const push = (dateStr: string | undefined, type: string, desc: string, effect?: string) => {
    if (dateStr) timeline.push({ dateText: dateStr, type, nature: "FATO_CONFIRMADO", description: desc, legalEffect: effect ?? null });
  };
  push(s("dataFatoGerador"), "CONSTITUICAO_CREDITO", "Fato gerador informado", "Marco da decadência");
  push(s("dataConstituicaoDefinitiva"), "CONSTITUICAO_CREDITO", "Constituição definitiva informada", "Início do prazo do art. 174 CTN");
  push(s("dataInscricaoDividaAtiva"), "INSCRICAO_DIVIDA_ATIVA", "Inscrição em dívida ativa informada");
  push(s("dataAjuizamento"), "AJUIZAMENTO", "Ajuizamento informado");
  push(s("dataDespachoCitatorio"), "DESPACHO_CITATORIO", "Despacho citatório informado", "Marco interruptivo (art. 174, § único, I, CTN)");
  push(s("dataCitacao"), "CITACAO", "Citação informada");
  if (redir) {
    push(s("dataCitacaoPJ"), "CITACAO", "Citação da pessoa jurídica informada", "Termo inicial do redirecionamento (Tema 444)");
    push(s("dataDissolucaoIrregular"), "MANIFESTACAO", "Dissolução irregular / ato inequívoco informado", "Termo inicial do redirecionamento (Tema 444)");
    push(s("dataPedidoRedirecionamento"), "MANIFESTACAO", "Pedido de redirecionamento / citação do sócio informado", "Marco final do redirecionamento");
  }

  const faltando = dedupe([...dec.faltando, ...ord.faltando, ...inter.faltando, ...(redir?.faltando ?? [])]);
  const algumSim = quadro.some((q) => q.resultado === "SIM");
  const tesePrincipal =
    quadro.find((q) => q.resultado === "SIM")?.instituto ?? "Indeterminada — depende de confirmação documental";

  return {
    mode: "heuristico",
    parties: { creditor: input.analysis.creditor ?? null, debtor: input.analysis.debtor ?? null, processNumber: input.analysis.processNumber ?? null },
    conclusaoDirecta:
      "Análise em MODO HEURÍSTICO (IA não configurada), baseada apenas nas datas informadas. " +
      (algumSim
        ? `Indício de ${tesePrincipal.toLowerCase()} — a ser confirmado nos autos. A EPE segue CONDICIONADA à confirmação documental.`
        : "Não há, com as datas informadas, indício suficiente. Confirme os documentos indicados.") +
      " Grau de confiança: baixo. Revisão por advogado(a) obrigatória.",
    quadro,
    tesePrincipal,
    tesesSubsidiarias: [],
    cabimentoEPE: algumSim ? "INDETERMINADO" : "INDETERMINADO",
    timeline,
    documentosFaltantes: faltando,
    epe: {
      titulo: "CONDICIONADA",
      markdown: buildHeuristicEpe(input, quadro, tesePrincipal),
    },
    confidence: faltando.length ? "INDETERMINADO" : "BAIXO",
  };
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

// ---------------------------------------------------------------------------
// Renderização — Relatório (seções 1-3) e EPE (seção 4)
// ---------------------------------------------------------------------------

/**
 * Relatório da ANÁLISE DIRIGIDA: os 11 blocos padronizados da especificação,
 * sempre na mesma ordem. Toda análise dirigida termina com esta estrutura,
 * qualquer que seja a matéria e o resultado.
 */
function buildDirigidaMarkdown(title: string, data: AnalysisResultData, d: NonNullable<AnalysisResultData["dirigida"]>): string {
  const m = materiaPorSlug(d.tipoAnalise);
  const vt = d.verificacaoTemporal;
  const lista = (itens: string[], vazio: string) => (itens.length ? itens.map((i) => `- ${i}`).join("\n") : `_${vazio}_`);
  const dataBR = (iso: string | null) => (iso ? iso.split("-").reverse().join("/") : "-");

  const quadro = d.linhaDoTempo.length
    ? d.linhaDoTempo
        .map(
          (e) =>
            `| ${e.data} | ${e.evento} | ${e.pagina || "-"} | ${e.classificacao || "-"} | ${e.efeitoJuridico || "-"} | ${GRAU_CONFIANCA[e.confianca]} |`,
        )
        .join("\n")
    : "| - | Nenhum evento datado localizado. | - | - | - | - |";

  const SITUACAO: Record<string, string> = {
    consumado: "prazo completo na data da análise",
    em_andamento: "prazo em andamento (consumação futura)",
    indeterminado: "não foi possível determinar a situação do prazo",
  };

  return [
    `# Análise de ${m.label} — ${title}`,
    data.mode === "heuristico"
      ? `> ⚠️ **Modo heurístico** (IA não consultada). Baseado apenas nas datas identificadas.`
      : `> Análise assistida por IA. Revisão humana obrigatória.`,
    ``,
    `**Data da análise:** ${dataBR(vt.dataAnalise)}`,
    ``,
    vt.corrigido
      ? `> 🔴 **Correção automática aplicada:** a conclusão original da IA (${vt.resultadoOriginalIA}) era incompatível com as datas calculadas e foi ajustada pela verificação temporal do sistema.`
      : "",
    ``,
    `## 1. Resposta objetiva`,
    `**${m.pergunta}**`,
    ``,
    `**${rotuloConclusao(d.tipoAnalise, d.resultado)}**`,
    ``,
    d.conclusao,
    ``,
    `**Situação do prazo:** ${SITUACAO[vt.situacaoPrazo]}${vt.dataConsumacao ? ` · consumação em ${dataBR(vt.dataConsumacao)}` : ""}`,
    ``,
    ...(vt.memoriaCalculo.length
      ? [`### Memória de cálculo (gerada pelo sistema)`, ...vt.memoriaCalculo.map((l) => `- ${l}`), ``]
      : []),
    `## 2. Fundamentação jurídica`,
    lista(d.fundamentacaoLegal, "Nenhum dispositivo indicado."),
    ``,
    `### Cálculo do prazo`,
    `- Marco inicial: ${d.calculoPrazo.marcoInicial}`,
    `- Prazo aplicável: ${d.calculoPrazo.prazoAplicavel}`,
    `- Marco final: ${d.calculoPrazo.marcoFinal}`,
    `- Data provável da consumação: ${d.calculoPrazo.dataProvavelConsumacao}`,
    ``,
    d.calculoPrazo.explicacao,
    ``,
    `## 3. Linha do tempo`,
    d.linhaDoTempo.length
      ? d.linhaDoTempo.map((e) => `- **${e.data}** — ${e.evento}${e.pagina ? ` (pág. ${e.pagina})` : ""}`).join("\n")
      : "_Nenhum evento datado foi localizado no documento analisado._",
    ``,
    `## 4. Quadro cronológico`,
    `| Data | Ato processual | Página | Classificação | Efeito jurídico | Confiança |`,
    `| --- | --- | --- | --- | --- | --- |`,
    quadro,
    ``,
    `## 5. Documentos utilizados`,
    lista(d.documentosUtilizados, "Nenhum documento identificado."),
    ``,
    `## 6. Documentos ausentes`,
    lista(d.documentosAusentes, "Nenhuma ausência apontada."),
    ``,
    `## 7. Riscos da conclusão`,
    lista(d.riscos, "Nenhum risco específico apontado."),
    ``,
    `## 8. Estratégia processual recomendada`,
    d.estrategiaRecomendada,
    ``,
    `## 9. Jurisprudência aplicável`,
    lista(d.precedentes, "Nenhum precedente indicado."),
    ``,
    `## 10. Peça processual sugerida`,
    d.resultado === "positivo" && d.peticao
      ? `${d.medidaProcessualSugerida || "Exceção de Pré-Executividade"}. ${d.justificativaMedida} A minuta completa está na aba **Minuta** desta análise, disponível para download.`
      : `**Minuta não disponibilizada porque os documentos atuais não comprovam a consumação da ${m.label.toLowerCase()}.** ${d.estrategiaRecomendada}`,
    ``,
    `## 11. Grau de confiança da análise`,
    `**${GRAU_CONFIANCA[d.grauConsistencia]}.** ${d.justificativaConfianca}`,
    ``,
    `---`,
    `> ${d.avisoLegal}`,
  ].join("\n");
}

/** Relatório = seções 1 a 3 do formato obrigatório (a peça é a seção 4). */
export function buildReportMarkdown(title: string, data: AnalysisResultData): string {
  // Análise dirigida usa o relatório padronizado de 11 blocos.
  if (data.dirigida) return buildDirigidaMarkdown(title, data, data.dirigida);
  const quadro = data.quadro
    .map((q) => `| ${q.instituto} | ${q.resultado} | ${q.motivo}${q.prazoFinal ? ` (prazo: ${q.prazoFinal})` : ""} |`)
    .join("\n");

  const timeline = data.timeline.length
    ? data.timeline.map((t) => `| ${t.dateText ?? t.eventDate ?? "—"} | ${t.description} | ${t.legalEffect ?? "—"} |`).join("\n")
    : "| — | Indeterminada nos documentos analisados. | — |";

  return [
    `# Análise — ${title}`,
    data.mode === "heuristico" ? `> ⚠️ **Modo heurístico** (IA não configurada). Baseado apenas nas datas informadas.` : `> Análise assistida por IA. Revisão humana obrigatória.`,
    ``,
    `## 1. Conclusão direta`,
    data.conclusaoDirecta,
    ``,
    `**Tese principal recomendada:** ${data.tesePrincipal}`,
    data.tesesSubsidiarias.length ? `**Teses subsidiárias:** ${data.tesesSubsidiarias.join("; ")}` : "",
    `**Cabimento da Exceção de Pré-Executividade:** ${data.cabimentoEPE} (Súmula 393/STJ)`,
    `**Grau de confiança:** ${data.confidence}`,
    ``,
    `## 2. Quadro objetivo dos institutos`,
    `| Instituto | Resultado | Motivo |`,
    `| --- | --- | --- |`,
    quadro,
    ``,
    `## 3. Linha do tempo essencial`,
    `| Data | Evento | Relevância |`,
    `| --- | --- | --- |`,
    timeline,
    ``,
    data.documentosFaltantes.length ? `## Documentos / informações a confirmar\n${data.documentosFaltantes.map((d) => `- ${d}`).join("\n")}` : "",
    ``,
    `## 4. Exceção de Pré-Executividade`,
    `A minuta completa está disponível na aba **Minuta** desta análise e para download em DOCX/PDF.`,
    ``,
    `---`,
    `> ${AVISO_RESPONSABILIDADE}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Peça (EPE) para modo heurístico — sempre CONDICIONADA. */
function buildHeuristicEpe(input: RunInput, quadro: InstitutoRow[], tese: string): string {
  const P = "[DATA NÃO LOCALIZADA — confirmar na CDA / decisão / certidão / intimação]";
  const proc = input.analysis.processNumber ?? P;
  const exec = input.analysis.debtor ?? "[EXECUTADO — PREENCHER]";
  const faz = input.analysis.creditor ?? "[FAZENDA EXEQUENTE — PREENCHER]";
  return [
    `# EXCEÇÃO DE PRÉ-EXECUTIVIDADE CONDICIONADA À CONFIRMAÇÃO DOCUMENTAL`,
    ``,
    `> ⚠️ Minuta gerada em modo heurístico (sem IA), a partir apenas das datas informadas. Confirme os documentos e datas nos autos antes do protocolo.`,
    ``,
    `EXCELENTÍSSIMO(A) SENHOR(A) DOUTOR(A) JUIZ(A) DE DIREITO DA ___ VARA DE EXECUÇÕES FISCAIS DA COMARCA DE ${P}`,
    ``,
    `Processo nº: ${proc}`,
    ``,
    `${exec}, já qualificado(a) nos autos da Execução Fiscal movida por ${faz}, vem, por seu advogado, com fundamento na Súmula 393/STJ, no art. 40 da LEF e nos arts. 156, V, e 174 do CTN, apresentar`,
    ``,
    `**EXCEÇÃO DE PRÉ-EXECUTIVIDADE**`,
    ``,
    `## I. SÍNTESE OBJETIVA DA EXECUÇÃO`,
    `Trata-se de execução fiscal referente ao crédito em cobrança. Tese principal apontada na triagem: **${tese}**. As datas abaixo devem ser confirmadas nos autos.`,
    ``,
    `## II. CABIMENTO`,
    `A matéria é de ordem pública, conhecível de ofício (art. 487, II, CPC; art. 156, V, CTN) e comprovável de plano, sem dilação probatória, dispensada a garantia do juízo (Súmula 393/STJ; art. 16, §1º, LEF a contrario).`,
    ``,
    `## III. DA TESE PRINCIPAL`,
    `${P} — marco inicial; ${P} — marco final; demonstrar aritmeticamente o decurso do prazo aplicável (art. 174 CTN / art. 40 LEF / arts. 150, §4º ou 173, I, CTN, conforme o caso). [CONFERIR JURISPRUDÊNCIA APLICÁVEL: Súmulas 314/393/409/436/555/622; Temas 566-571/383/444/163; Tema 390/STF.]`,
    ``,
    `## IV. DOS PEDIDOS`,
    `a) o recebimento e acolhimento da presente; b) o reconhecimento da ${tese.toLowerCase()}; c) a extinção do crédito tributário (art. 156, V, CTN); d) a extinção da execução com resolução de mérito (art. 487, II, CPC); e) a baixa de constrições (penhoras, SISBAJUD, RENAJUD, CNIB, protesto); f) a condenação em honorários (art. 85 CPC).`,
    ``,
    `Nestes termos, pede deferimento.`,
    ``,
    `${P} (local e data)`,
    ``,
    `[ADVOGADO(A) — OAB/UF nº ___]`,
    ``,
    `---`,
    `> ${AVISO_RESPONSABILIDADE}`,
  ].join("\n");
}
