/**
 * Detecção determinística de eventos-chave nas páginas do processo.
 *
 * MOTIVO (caso real): no IPTU municipal a IA montou a linha do tempo com
 * 4 eventos e OMITIU a intimação de 17/12/2018 e a certidão de inércia de
 * 20/05/2021 — justamente os fatos que definem o marco da prescrição
 * intercorrente. Quando a extração falha, tudo que vem depois (contagem,
 * conclusão, confronto) falha junto. Este módulo varre as páginas com padrões
 * fixos e entrega ao modelo a lista do que ELE é obrigado a incorporar à linha
 * do tempo, com página e data. O modelo confirma e classifica; a detecção
 * garante que nada estruturalmente importante suma.
 */

export interface PaginaTexto {
  page: number;
  text: string;
}

export interface EventoChave {
  pagina: number;
  tipo: string;
  descricao: string;
  datas: string[];
}

interface Padrao {
  tipo: string;
  descricao: string;
  re: RegExp;
}

/**
 * Padrões dos atos que mudam contagem de prazo. Deliberadamente RECALL alto:
 * um falso positivo custa uma linha a mais para o modelo conferir; um falso
 * negativo derruba o marco da análise.
 */
const PADROES: Padrao[] = [
  {
    tipo: "intimacao-prosseguimento",
    descricao: "Intimação/despacho para a Fazenda dar prosseguimento",
    re: /diga\s+a\s+(?:fazenda|exequente)[^.\n]{0,80}(?:prosseguimento|termos)|intime[-\s]?se[^.\n]{0,60}(?:fazenda|exequente|munic[íi]pio|prefeitura)|manifest[ae][^.\n]{0,60}(?:fazenda|exequente)[^.\n]{0,60}prosseguimento/i,
  },
  {
    tipo: "inicio-intimacao",
    descricao: "Certidão com a data de INÍCIO da intimação (portal eletrônico)",
    re: /in[íi]cio\s+do\s+ato|considera-se[^.\n]{0,80}intima[çc][ãa]o|teor\s+do\s+ato[^.\n]{0,60}dispon[íi]vel|intima[çc][ãa]o\s+autom[áa]tica/i,
  },
  {
    tipo: "inercia-certificada",
    descricao: "Certidão de decurso de prazo SEM manifestação da Fazenda",
    re: /decorr\w+\s+o?\s*prazo\s+sem\s+manifesta[çc][ãa]o|sem\s+manifesta[çc][ãa]o\s+da\s+(?:fazenda|exequente)|transcorr\w+[^.\n]{0,50}sem\s+manifesta[çc][ãa]o/i,
  },
  {
    tipo: "suspensao-art40",
    descricao: "Suspensão do feito (art. 40 da LEF)",
    // "suspens[ãa]o" precisa do "ã" literal: o \w do JavaScript é ASCII e não
    // casa acento, então "suspensão" escapava do padrão.
    re: /suspen(?:s[ãa]o|d[oa]|so)[^\n]{0,100}art(?:igo)?\.?\s*40|art(?:igo)?\.?\s*40[^\n]{0,80}(?:LEF|6\.?830)/i,
  },
  {
    tipo: "arquivamento",
    descricao: "Arquivamento (com ou sem baixa)",
    re: /arquiv(?:amento|em?-se|ado)\s*(?:sem\s+baixa)?/i,
  },
  {
    tipo: "citacao",
    descricao: "Citação (qualquer modalidade) ou AR",
    re: /carta\s+de\s+cita[çc][ãa]o|mandado\s+de\s+cita[çc][ãa]o|aviso\s+de\s+recebimento|cita[çc][ãa]o\s+(?:postal|por\s+edital|eletr[ôo]nica)|deixou\s+de\s+proceder\s+[àa]\s+cita[çc][ãa]o|citad[oa]/i,
  },
  {
    tipo: "constricao",
    descricao: "Penhora ou bloqueio com resultado",
    re: /penhora\s+(?:efetivada|realizada|lavrada)|bloqueio[^.\n]{0,60}(?:efetivado|positivo|R\$)|termo\s+de\s+penhora/i,
  },
  {
    tipo: "parcelamento-pagamento",
    descricao: "Parcelamento, adesão ou pagamento",
    re: /parcelamento|\bREFIS\b|\bPAES\b|\bPERT\b|lei\s+n?[ºo]?\s*11\.?941|DARF|comprovante\s+de\s+pagamento/i,
  },
];

const RE_DATA = /\b[0-3]?\d\/[01]?\d\/\d{4}\b/g;

/** Varre as páginas e devolve os eventos-chave com as datas de cada página. */
export function detectarEventosChave(paginas: PaginaTexto[], maxEventos = 24): EventoChave[] {
  const eventos: EventoChave[] = [];
  for (const p of paginas) {
    if (!p.text || p.text.length < 20) continue;
    for (const padrao of PADROES) {
      if (!padrao.re.test(p.text)) continue;
      const datas = [...new Set(p.text.match(RE_DATA) ?? [])].slice(0, 6);
      eventos.push({ pagina: p.page, tipo: padrao.tipo, descricao: padrao.descricao, datas });
    }
  }
  // Uma entrada por (página, tipo); limite total para não inflar o prompt.
  return eventos.slice(0, maxEventos);
}

import { extrairData, somarAnos, formatarBR } from "./verificacao-temporal";
import type { MateriaSlug } from "../ai/materias";

/** Tipos de evento que podem constituir marco inicial da contagem. */
const TIPOS_MARCO = new Set([
  "intimacao-prosseguimento",
  "inicio-intimacao",
  "inercia-certificada",
  "suspensao-art40",
  "arquivamento",
]);

/** Tipos de evento que obstam a contagem quando posteriores ao candidato. */
const TIPOS_OBSTATIVOS = new Set(["constricao", "parcelamento-pagamento"]);

export interface CandidatoMarcoVencido {
  data: string;
  pagina: number;
  descricao: string;
  consumacaoCalculada: string;
}

/**
 * Candidatos a marco cuja contagem JÁ VENCEU, calculados a partir do DETECTOR,
 * não da linha do tempo da IA.
 *
 * MOTIVO: o confronto do servidor com o modelo dependia da linha do tempo que
 * o próprio modelo montava — quando ele omitia a intimação de 2018, não havia
 * o que confrontar. O detector lê as páginas diretamente, então o candidato
 * existe SEMPRE que o texto o contém, independentemente do humor do modelo.
 */
export function candidatosMarcoVencidos(
  eventos: EventoChave[],
  materia: MateriaSlug,
  agora: Date = new Date(),
): CandidatoMarcoVencido[] {
  const anos = materia === "prescricao_intercorrente" ? 6 : 5;

  // Datas de atos obstativos, para descartar candidato superado por eles.
  const obstativos: Date[] = [];
  for (const e of eventos) {
    if (!TIPOS_OBSTATIVOS.has(e.tipo)) continue;
    for (const dt of e.datas) {
      const d = extrairData(dt);
      if (d) obstativos.push(d);
    }
  }

  const vistos = new Set<string>();
  const out: CandidatoMarcoVencido[] = [];
  for (const e of eventos) {
    if (!TIPOS_MARCO.has(e.tipo)) continue;
    // A data do ato é a MAIS RECENTE da página: numa certidão de intimação, é o
    // início do ato (17/12/2018), não a data da lavratura (13/12/2018).
    const datas = e.datas.map(extrairData).filter((d): d is Date => d !== null);
    if (datas.length === 0) continue;
    const d = new Date(Math.max(...datas.map((x) => x.getTime())));
    const consumacao = somarAnos(d, anos);
    if (consumacao.getTime() > agora.getTime()) continue;
    if (obstativos.some((o) => o.getTime() > d.getTime())) continue;
    const chave = formatarBR(d);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    out.push({ data: chave, pagina: e.pagina, descricao: e.descricao, consumacaoCalculada: formatarBR(consumacao) });
  }

  out.sort((a, b) => a.data.split("/").reverse().join("").localeCompare(b.data.split("/").reverse().join("")));
  return out.slice(0, 3);
}

/**
 * Bloco injetado no prompt do usuário. A instrução é imperativa: o modelo pode
 * refutar um evento (falso positivo do padrão), mas não pode ignorá-lo.
 */
export function formatarEventosChave(eventos: EventoChave[]): string {
  if (eventos.length === 0) return "";
  const linhas = eventos.map(
    (e) => `- p.${e.pagina}: ${e.descricao}${e.datas.length ? ` · datas na página: ${e.datas.join(", ")}` : ""}`,
  );
  return [
    "",
    "=== EVENTOS-CHAVE DETECTADOS PELO SISTEMA (varredura determinística das páginas) ===",
    "Cada item abaixo foi encontrado por padrão textual na página indicada. Você DEVE conferir cada um no texto e:",
    "- INCORPORÁ-LO à `linhaDoTempo` com data, página, classificação e efeito jurídico; ou",
    "- refutá-lo expressamente em `pontosParaAvaliacao`, se for falso positivo do padrão.",
    "É PROIBIDO simplesmente omitir um evento desta lista.",
    ...linhas,
  ].join("\n");
}
