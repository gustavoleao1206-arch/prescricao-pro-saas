import type { MateriaSlug } from "../ai/materias";

/**
 * Checklist de documentos por matéria: detecção DETERMINÍSTICA, antes da IA.
 *
 * Duas razões para isso não ser tarefa do modelo:
 *  1. O checklist decide o aviso "a conclusão poderá ser limitada", e um aviso
 *     de limitação não pode depender de quem tem incentivo a parecer completo.
 *  2. Ele roda ANTES da análise, na tela de confirmação, quando ainda não houve
 *     chamada de IA nem cobrança de crédito.
 *
 * Este arquivo é também a FONTE ÚNICA das listas de documentos prioritários:
 * os motores de prompt importam daqui, então o que a IA é instruída a procurar
 * e o que o detector verifica nunca divergem.
 *
 * A detecção é textual (regex sobre o corpus extraído). Ela sinaliza presença
 * PROVÁVEL: serve para orientar o cliente e a IA, não para afirmar juntada.
 */

export interface DocumentoEsperado {
  id: string;
  rotulo: string;
  /** Sem este documento a conclusão fica limitada e o cliente é avisado. */
  essencial: boolean;
  /** Qualquer padrão casando no corpus marca o documento como encontrado. */
  padroes: RegExp[];
  /** Por que o documento importa (exibido quando essencial e ausente). */
  motivo?: string;
}

export interface ItemChecklist {
  id: string;
  rotulo: string;
  essencial: boolean;
  encontrado: boolean;
}

export interface ChecklistDocumentos {
  materia: MateriaSlug;
  itens: ItemChecklist[];
  encontrados: number;
  total: number;
  essenciaisAusentes: string[];
  /** true quando falta documento essencial: a conclusão poderá ser limitada. */
  limitada: boolean;
  /** Mensagem pronta para exibição, no texto exigido pela especificação. */
  aviso: string | null;
}

// ---------------------------------------------------------------------------
// Padrões compartilhados entre matérias
// ---------------------------------------------------------------------------

const CDA: DocumentoEsperado = {
  id: "cda",
  rotulo: "CDA (Certidão de Dívida Ativa)",
  essencial: true,
  padroes: [/certid[ãa]o\s+d[ea]\s+d[íi]vida\s+ativa/i, /\bCDA\b/],
};

const PETICAO_INICIAL: DocumentoEsperado = {
  id: "peticao-inicial",
  rotulo: "Petição inicial da execução",
  essencial: true,
  padroes: [/peti[çc][ãa]o\s+inicial/i, /\bexordial\b/i, /inicial\s+da\s+execu[çc][ãa]o/i],
};

const DESPACHO_CITATORIO: DocumentoEsperado = {
  id: "despacho-citatorio",
  rotulo: "Despacho que determina a citação",
  essencial: true,
  padroes: [/cite[\s-]?se/i, /despacho[^.\n]{0,60}cita[çc][ãa]o/i, /determin[oa][^.\n]{0,40}cita[çc][ãa]o/i],
};

/**
 * Citação por QUALQUER modalidade. Um único item agrupado de propósito: exigir
 * "mandado do oficial" num processo citado por carta postal com AR fazia o
 * sistema apontar ausência inexistente (defeito real do caso de teste). Carta,
 * mandado, citação eletrônica, edital ou comparecimento espontâneo: qualquer
 * uma conta como citação localizada.
 */
const CITACAO: DocumentoEsperado = {
  id: "citacao",
  rotulo: "Citação (carta, mandado, eletrônica ou edital)",
  essencial: false,
  padroes: [
    /carta\s+de\s+cita[çc][ãa]o/i,
    /cita[çc][ãa]o\s+(?:postal|pelo\s+correio|por\s+carta)/i,
    /mandado\s+de\s+cita[çc][ãa]o/i,
    /cita[çc][ãa]o\s+eletr[ôo]nica/i,
    /cita[çc][ãa]o\s+por\s+edital/i,
    /edital\s+de\s+cita[çc][ãa]o/i,
    /comparecimento\s+espont[âa]neo/i,
    /citad[oa]\s+(?:em|por|via)/i,
    /certid[ãa]o\s+de\s+cita[çc][ãa]o/i,
  ],
};

const AR: DocumentoEsperado = {
  id: "ar",
  rotulo: "Aviso de Recebimento (AR)",
  essencial: false,
  // "AR" sem case-insensitive: com a flag, casaria a palavra "ar" em qualquer frase.
  padroes: [/aviso\s+de\s+recebimento/i, /\bA\.?R\.?\b/],
};

const MOVIMENTACAO: DocumentoEsperado = {
  id: "movimentacao",
  rotulo: "Movimentação processual",
  essencial: false,
  padroes: [/movimenta[çc][ãa]o\s+processual/i, /movimenta[çc][õo]es\b/i, /andamento(?:s)?\s+processual/i],
};

// ---------------------------------------------------------------------------
// Listas por matéria (a ordem é a de exibição do checklist)
// ---------------------------------------------------------------------------

const INTERCORRENTE: DocumentoEsperado[] = [
  CDA,
  PETICAO_INICIAL,
  DESPACHO_CITATORIO,
  CITACAO,
  AR,
  {
    id: "certidao-oficial",
    rotulo: "Certidões do Oficial de Justiça",
    essencial: false,
    padroes: [/certid[ãa]o\s+d[oe]\s+oficial/i, /oficial\s+de\s+justi[çc]a/i],
  },
  {
    id: "suspensao-art40",
    rotulo: "Decisão de suspensão (art. 40 da LEF)",
    essencial: true,
    motivo:
      "É a decisão que instaura a sistemática do art. 40 da LEF; sem ela não há como fixar o início do período de suspensão.",
    padroes: [
      /art(?:igo)?\.?\s*40[^.\n]{0,80}(?:LEF|6\.?830)/i,
      /suspens[ãa]o\s+d[oa]\s+(?:processo|execu[çc][ãa]o|curso|feito)/i,
      /suspendo\s+o\s+(?:curso|processo|feito)/i,
    ],
  },
  {
    id: "ciencia-fazenda",
    rotulo: "Intimação ou ciência da Fazenda sobre a suspensão",
    essencial: true,
    motivo:
      "Define o termo inicial da sistemática do art. 40 (Tema 566/STJ): o prazo corre da CIÊNCIA da Fazenda, não da data da decisão.",
    padroes: [
      /intima[çc][ãa]o\s+autom[áa]tica/i,
      /portal\s+eletr[ôo]nico/i,
      /ci[êe]ncia\s+d[ao]\s+Fazenda/i,
      /intimad[ao]\s+a\s+Fazenda/i,
      /intime[\s-]?se\s+a\s+Fazenda/i,
      /Fazenda[^.\n]{0,50}(?:intimad|cient)/i,
    ],
  },
  {
    id: "resultado-pesquisa-patrimonial",
    rotulo: "Resultado das pesquisas patrimoniais",
    essencial: true,
    motivo:
      "Pode definir o momento em que a Fazenda tomou ciência da inexistência de bens penhoráveis e, consequentemente, o termo inicial da sistemática do art. 40 da LEF.",
    padroes: [
      /resultado[^.\n]{0,50}(?:pesquisa|SISBAJUD|BACENJUD|RENAJUD|INFOJUD)/i,
      /(?:SISBAJUD|BACENJUD)[^.\n]{0,80}(?:negativ|sem\s+saldo|infrut[íi]fer|valor\s+irris[óo]rio|n[ãa]o\s+localizad)/i,
      /certid[ãa]o[^.\n]{0,60}(?:inexist[êe]ncia|aus[êe]ncia)\s+de\s+bens/i,
      /n[ãa]o\s+(?:foram\s+)?localizados?\s+bens/i,
      /bloqueio[^.\n]{0,40}(?:negativo|infrut[íi]fero|sem\s+êxito)/i,
    ],
  },
  {
    id: "arquivamento",
    rotulo: "Decisão de arquivamento",
    essencial: false,
    padroes: [/arquiv(?:amento|em?-se|ado[s]?|e-se)/i],
  },
  MOVIMENTACAO,
  {
    id: "peticoes-fazenda",
    rotulo: "Petições da Fazenda Pública",
    essencial: false,
    padroes: [/fazenda\s+(?:p[úu]blica\s+)?(?:nacional|estadual|municipal)?[^.\n]{0,60}(?:requer|manifesta|petici)/i, /procurador(?:ia)?[^.\n]{0,50}(?:requer|manifesta)/i],
  },
  {
    id: "sisbajud",
    rotulo: "Pesquisas SISBAJUD/BACENJUD",
    essencial: false,
    padroes: [/SISBAJUD/i, /BACENJUD/i],
  },
  { id: "renajud", rotulo: "Pesquisas RENAJUD", essencial: false, padroes: [/RENAJUD/i] },
  { id: "infojud", rotulo: "Pesquisas INFOJUD", essencial: false, padroes: [/INFOJUD/i] },
  { id: "serasajud", rotulo: "Pesquisas SERASAJUD", essencial: false, padroes: [/SERASAJUD/i] },
  {
    id: "diligencias-patrimoniais",
    rotulo: "Demais diligências patrimoniais",
    essencial: false,
    padroes: [/penhora/i, /constri[çc][ãa]o/i, /bloqueio\s+de\s+(?:valores|ativos)/i, /diligência[^.\n]{0,40}patrimonial/i],
  },
  {
    id: "parcelamento",
    rotulo: "Parcelamentos ou pagamentos",
    essencial: false,
    padroes: [/parcelamento/i, /\bREFIS\b/i, /\bPAES\b/, /\bPERT\b/, /pagamento/i],
  },
  {
    id: "sentenca",
    rotulo: "Sentença ou decisões finais",
    essencial: false,
    padroes: [/senten[çc]a/i, /julgo\s+extint/i],
  },
];

const ORDINARIA: DocumentoEsperado[] = [
  CDA,
  PETICAO_INICIAL,
  DESPACHO_CITATORIO,
  CITACAO,
  AR,
  {
    id: "parcelamento",
    rotulo: "Parcelamentos",
    essencial: false,
    padroes: [/parcelamento/i, /parcelou/i, /\bREFIS\b/i, /\bPAES\b/, /\bPERT\b/],
  },
  {
    id: "confissao",
    rotulo: "Confissão de dívida",
    essencial: false,
    padroes: [/confiss[ãa]o\s+de\s+d[íi]vida/i, /termo\s+de\s+confiss[ãa]o/i],
  },
  {
    id: "pagamento-parcial",
    rotulo: "Pagamentos parciais",
    essencial: false,
    padroes: [/pagamento\s+parcial/i, /\bDARF\b/, /\bGRU\b/, /guia\s+de\s+recolhimento/i],
  },
  {
    id: "extrato-divida",
    rotulo: "Extrato da dívida ativa",
    essencial: false,
    padroes: [/extrato\s+d[ae]\s+d[íi]vida/i, /demonstrativo\s+d[ea]\s+d[ée]bito/i],
  },
  {
    id: "historico-inscricao",
    rotulo: "Histórico da inscrição",
    essencial: false,
    padroes: [/inscri[çc][ãa]o\s+em\s+d[íi]vida\s+ativa/i, /hist[óo]rico\s+da\s+inscri[çc][ãa]o/i],
  },
];

const DECADENCIA: DocumentoEsperado[] = [
  {
    id: "auto-infracao",
    rotulo: "Auto de Infração",
    essencial: true,
    padroes: [/auto\s+de\s+infra[çc][ãa]o/i, /\bAIIM\b/],
  },
  {
    id: "notificacao-lancamento",
    rotulo: "Notificação do lançamento",
    essencial: true,
    padroes: [/notifica[çc][ãa]o\s+d[eo]\s+lan[çc]amento/i, /notificad[oa]/i],
  },
  {
    id: "paf",
    rotulo: "Processo Administrativo Fiscal",
    essencial: false,
    padroes: [/processo\s+administrativo(?:\s+fiscal)?/i, /\bPAF\b/],
  },
  {
    id: "defesa-administrativa",
    rotulo: "Defesa administrativa / impugnação",
    essencial: false,
    padroes: [/impugna[çc][ãa]o/i, /defesa\s+administrativa/i],
  },
  {
    id: "recursos-administrativos",
    rotulo: "Recursos administrativos",
    essencial: false,
    padroes: [/recurso\s+(?:volunt[áa]rio|administrativo|de\s+of[íi]cio)/i, /\bCARF\b/, /conselho\s+de\s+contribuintes/i],
  },
  {
    id: "decisao-administrativa",
    rotulo: "Decisão administrativa",
    essencial: false,
    padroes: [/decis[ãa]o\s+administrativa/i, /julgamento\s+administrativo/i, /ac[óo]rd[ãa]o\s+administrativo/i],
  },
  {
    id: "constituicao-definitiva",
    rotulo: "Constituição definitiva do crédito",
    essencial: false,
    padroes: [/constitui[çc][ãa]o\s+definitiva/i, /definitivamente\s+constitu[íi]do/i],
  },
  {
    id: "lancamento",
    rotulo: "Lançamento",
    essencial: false,
    padroes: [/lan[çc]amento/i],
  },
  CDA,
  {
    id: "extrato-divida",
    rotulo: "Extrato da dívida",
    essencial: false,
    padroes: [/extrato\s+d[ae]\s+d[íi]vida/i, /demonstrativo\s+d[ea]\s+d[ée]bito/i],
  },
];

export const DOCUMENTOS_POR_MATERIA: Record<MateriaSlug, DocumentoEsperado[]> = {
  prescricao_intercorrente: INTERCORRENTE,
  prescricao_ordinaria: ORDINARIA,
  decadencia_tributaria: DECADENCIA,
};

/** Nome da matéria como aparece na mensagem de aviso exigida. */
const NOME_NA_MENSAGEM: Record<MateriaSlug, string> = {
  prescricao_intercorrente: "prescrição intercorrente",
  prescricao_ordinaria: "prescrição ordinária",
  decadencia_tributaria: "decadência",
};

/**
 * Monta o checklist da matéria contra o texto extraído do processo.
 *
 * `texto` deve ser o corpus COMPLETO (todas as páginas legíveis), não o corpus
 * truncado que vai à IA: um documento presente na página 300 continua presente
 * ainda que a página não caiba no orçamento de tokens.
 */
export function montarChecklist(materia: MateriaSlug, texto: string): ChecklistDocumentos {
  const documentos = DOCUMENTOS_POR_MATERIA[materia];
  const itens: ItemChecklist[] = documentos.map((d) => ({
    id: d.id,
    rotulo: d.rotulo,
    essencial: d.essencial,
    encontrado: d.padroes.some((re) => re.test(texto)),
  }));

  const ausentes = documentos.filter((d) => d.essencial && !itens.find((i) => i.id === d.id)?.encontrado);
  const essenciaisAusentes = ausentes.map((d) => d.rotulo);
  const limitada = essenciaisAusentes.length > 0;

  // Cada essencial ausente vem com a IMPORTÂNCIA dele: o cliente precisa saber
  // não só o que falta, mas por que faltar muda a conclusão.
  const detalhes = ausentes
    .map((d) => `Documento ausente: ${d.rotulo}.${d.motivo ? ` Importância: ${d.motivo}` : ""}`)
    .join(" ");

  return {
    materia,
    itens,
    encontrados: itens.filter((i) => i.encontrado).length,
    total: itens.length,
    essenciaisAusentes,
    limitada,
    aviso: limitada
      ? `Documento importante não localizado para análise da ${NOME_NA_MENSAGEM[materia]}: ` +
        `${essenciaisAusentes.join("; ")}. A conclusão poderá ser limitada. ${detalhes} ` +
        `Para uma análise mais precisa, junte os documentos indicados.`
      : null,
  };
}

/**
 * Checklist em texto simples (✓/✗), no formato da especificação. Usado no
 * prompt da IA e nas exportações.
 */
export function checklistEmTexto(c: ChecklistDocumentos): string {
  const linhas = c.itens.map((i) => `${i.encontrado ? "✓" : "✗"} ${i.rotulo}${i.essencial ? " (essencial)" : ""}`);
  return [
    `CHECKLIST DE DOCUMENTOS (detecção automática prévia): ${c.encontrados} de ${c.total} localizados.`,
    ...linhas,
    ...(c.aviso ? ["", c.aviso] : []),
  ].join("\n");
}

/** Recupera um checklist persistido em Analysis.facts, se houver e for válido. */
export function checklistDeFacts(facts: unknown): ChecklistDocumentos | null {
  if (typeof facts !== "object" || facts === null) return null;
  const c = (facts as Record<string, unknown>).checklistDocumentos;
  if (typeof c !== "object" || c === null) return null;
  const cc = c as Record<string, unknown>;
  if (!Array.isArray(cc.itens) || typeof cc.materia !== "string") return null;
  return c as unknown as ChecklistDocumentos;
}
