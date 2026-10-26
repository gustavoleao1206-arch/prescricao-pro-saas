import type { MateriaSlug } from "../ai/materias";

/**
 * Escolhe QUAIS páginas do processo vão para a IA.
 *
 * O limite de tokens do provedor não comporta um processo inteiro: 181 mil
 * caracteres de uma cópia integral contra ~26 mil de orçamento. Cortar pelos
 * "primeiros N caracteres" entrega a petição inicial e a CDA — e deixa de fora
 * exatamente as movimentações que decidem a matéria. Num caso real isso levou a
 * IA a responder "inconclusivo" sobre um processo que tinha o rito do art. 40
 * documentado a partir da página 40.
 *
 * Aqui as páginas são pontuadas pelos termos que importam para a matéria
 * escolhida, e o orçamento é preenchido da mais relevante para a menos. As
 * primeiras páginas entram sempre: é onde ficam partes, CDA e valor.
 */

export interface PaginaTexto {
  page: number;
  text: string;
}

export interface SelecaoPaginas {
  texto: string;
  paginasEnviadas: number[];
  paginasOmitidas: number;
  truncado: boolean;
}

/** Termos que sinalizam relevância, por matéria. Peso maior = mais decisivo. */
const TERMOS: Record<MateriaSlug, { re: RegExp; peso: number }[]> = {
  prescricao_intercorrente: [
    { re: /art(igo)?\.?\s*40|lei\s*6\.?830/gi, peso: 5 },
    { re: /suspens[ãa]o|suspend/gi, peso: 4 },
    { re: /arquiv/gi, peso: 4 },
    { re: /prescri[çc][ãa]o\s+intercorrente/gi, peso: 5 },
    { re: /penhora|bloqueio|constri[çc][ãa]o|sisbajud|bacenjud|renajud/gi, peso: 4 },
    { re: /parcelamento/gi, peso: 4 },
    { re: /cita[çc][ãa]o|citad|mandado/gi, peso: 3 },
    { re: /n[ãa]o\s+localizad|sem\s+bens|negativ/gi, peso: 3 },
    { re: /intimad|ci[êe]ncia\s+da\s+fazenda|manifest/gi, peso: 2 },
    { re: /desarquiv|diligência|diligencia/gi, peso: 2 },
  ],
  prescricao_ordinaria: [
    { re: /art(igo)?\.?\s*174|constitui[çc][ãa]o\s+definitiva/gi, peso: 5 },
    { re: /despacho.{0,30}cita[çc][ãa]o|cite-?se/gi, peso: 5 },
    { re: /cita[çc][ãa]o|citad/gi, peso: 4 },
    { re: /parcelamento|reconhecimento\s+d[oe]\s+d[ée]bito/gi, peso: 4 },
    { re: /inscri[çc][ãa]o.{0,20}d[íi]vida\s+ativa|CDA/gi, peso: 3 },
    { re: /vencimento|notifica[çc][ãa]o|lan[çc]amento/gi, peso: 3 },
    { re: /prescri[çc][ãa]o/gi, peso: 3 },
    { re: /suspens[ãa]o\s+da\s+exigibilidade|art(igo)?\.?\s*151/gi, peso: 3 },
    { re: /protesto|ajuizamento|distribu/gi, peso: 2 },
  ],
  decadencia_tributaria: [
    { re: /art(igo)?\.?\s*150|art(igo)?\.?\s*173|decad[êe]ncia/gi, peso: 5 },
    { re: /fato\s+gerador|per[íi]odo\s+de\s+apura[çc][ãa]o|compet[êe]ncia/gi, peso: 4 },
    { re: /pagamento\s+antecipado|DARF|GPS|guia\s+de\s+recolhimento/gi, peso: 4 },
    { re: /declara[çc][ãa]o|DCTF|GFIP|homologa/gi, peso: 4 },
    { re: /auto\s+de\s+infra[çc][ãa]o|lan[çc]amento|notifica[çc][ãa]o/gi, peso: 4 },
    { re: /dolo|fraude|simula[çc][ãa]o/gi, peso: 3 },
    { re: /processo\s+administrativo|impugna[çc][ãa]o|recurso/gi, peso: 2 },
  ],
};

/** Quantas páginas iniciais são candidatas à cota de identificação. */
const PAGINAS_INICIAIS = 4;

/**
 * Fatia do orçamento reservada às páginas iniciais.
 *
 * Sem esse teto, uma capa longa consome tudo e expulsa as páginas decisivas —
 * o feito continha o rito do art. 40, mas a IA só recebia a petição inicial.
 * Identificação é contexto; o que decide a matéria é a movimentação.
 */
const COTA_INICIAIS = 0.3;

export function selecionarPaginas(
  paginas: PaginaTexto[],
  materia: MateriaSlug | null,
  maxChars: number,
  /**
   * Páginas com PASSE LIVRE: entram antes da disputa por relevância.
   *
   * Vêm da varredura determinística de eventos-chave (deteccao-eventos.ts).
   * MOTIVO (caso real): no IPTU municipal a pontuação por termos
   * descartou as certidões curtas das páginas 10-15 — a intimação de
   * 17/12/2018 e a inércia certificada, exatamente o que define o marco da
   * intercorrente. A IA nunca viu o texto, então omitiu os eventos e errou o
   * marco. Página apontada pelo detector não disputa: entra.
   */
  obrigatorias: ReadonlySet<number> = new Set(),
): SelecaoPaginas {
  const comTexto = paginas.filter((p) => p.text.trim().length > 0);
  const rotular = (p: PaginaTexto) => `--- p.${p.page} ---\n${p.text}`;

  const total = comTexto.reduce((s, p) => s + rotular(p).length + 2, 0);
  if (total <= maxChars) {
    return {
      texto: comTexto.map(rotular).join("\n\n"),
      paginasEnviadas: comTexto.map((p) => p.page),
      paginasOmitidas: 0,
      truncado: false,
    };
  }

  const termos = materia ? TERMOS[materia] : [];
  const pontuar = (t: string): number => {
    let n = 0;
    for (const { re, peso } of termos) n += (t.match(re) ?? []).length * peso;
    return n;
  };

  // Ordem de entrada: páginas iniciais primeiro, depois por relevância. O
  // desempate por número de página mantém a leitura cronológica.
  const iniciais = comTexto.slice(0, PAGINAS_INICIAIS);
  const restantes = comTexto
    .slice(PAGINAS_INICIAIS)
    .map((p) => ({ p, score: pontuar(p.text) }))
    .sort((a, b) => b.score - a.score || a.p.page - b.p.page)
    .map((x) => x.p);

  const escolhidas: PaginaTexto[] = [];
  let usado = 0;
  const cabe = (p: PaginaTexto, teto: number) => usado + rotular(p).length + 2 <= teto;
  const incluir = (p: PaginaTexto) => {
    escolhidas.push(p);
    usado += rotular(p).length + 2;
  };

  // 1) Identificação, limitada à cota — capa longa não pode zerar o restante.
  const tetoIniciais = Math.floor(maxChars * COTA_INICIAIS);
  for (const p of iniciais) if (cabe(p, tetoIniciais)) incluir(p);

  // 2) Passe livre: páginas com evento-chave detectado, em ordem cronológica.
  for (const p of comTexto) {
    if (!obrigatorias.has(p.page) || escolhidas.includes(p)) continue;
    if (cabe(p, maxChars)) incluir(p);
  }

  // 3) O resto do orçamento vai para as páginas mais relevantes à matéria.
  for (const p of restantes) {
    if (escolhidas.includes(p)) continue;
    if (cabe(p, maxChars)) incluir(p);
  }

  // 4) Sobrou espaço? Completa com as iniciais que a cota barrou.
  for (const p of iniciais) {
    if (escolhidas.includes(p)) continue;
    if (cabe(p, maxChars)) incluir(p);
  }

  escolhidas.sort((a, b) => a.page - b.page);
  const omitidas = comTexto.length - escolhidas.length;

  return {
    texto: escolhidas.map(rotular).join("\n\n"),
    paginasEnviadas: escolhidas.map((p) => p.page),
    paginasOmitidas: omitidas,
    truncado: omitidas > 0,
  };
}
