/**
 * Leitura determinística de uma cópia de execução fiscal.
 *
 * Extrai identificação (processo, partes, vara, CDA, tributo) e as datas-marco
 * a partir do TEXTO do documento, sem IA. É um apoio à triagem: tudo que sai
 * daqui é HIPÓTESE a confirmar, nunca fato confirmado — por isso a análise
 * exibe os campos lidos para conferência do(a) advogado(a).
 *
 * Princípio de segurança: na dúvida, NÃO extrai. Um dado errado num parecer é
 * pior do que um campo vazio, porque o vazio o motor já reporta como pendência.
 */

export interface DadosExtraidos {
  processNumber?: string;
  court?: string;
  jurisdiction?: string;
  courtDivision?: string;
  creditor?: string;
  debtor?: string;
  debtorDocument?: string;
  cdaNumber?: string;
  taxType?: string;
  /** Datas no formato ISO (AAAA-MM-DD), prontas para o motor jurídico. */
  facts: Record<string, string>;
  /** Rótulos legíveis do que foi encontrado (para mostrar ao cliente). */
  encontrados: string[];
  /** Rótulos do que não foi possível ler e precisa de conferência. */
  ausentes: string[];
}

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

const MESES: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

/**
 * Remove acentos para casar rótulos escritos de formas diferentes.
 * Decompõe (NFD) e descarta os diacríticos combinantes, o que preserva o
 * comprimento em letras-base — importante porque as posições das datas são
 * calculadas sobre o texto normalizado.
 */
function semAcento(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function iso(ano: number, mes: number, dia: number): string | undefined {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return undefined;
  // Ano fora de faixa plausível para um processo tributário: descarta.
  if (ano < 1960 || ano > 2100) return undefined;
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return undefined; // 31/02 etc.
  return `${String(ano).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

interface DataAchada {
  iso: string;
  pos: number;
}

/** Todas as datas do texto (DD/MM/AAAA e "1º de março de 2019"), com posição. */
function todasAsDatas(texto: string): DataAchada[] {
  const achadas: DataAchada[] = [];

  const numerica = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g;
  for (const m of texto.matchAll(numerica)) {
    const [, d, mes, a] = m;
    if (!d || !mes || !a) continue;
    const v = iso(Number(a), Number(mes), Number(d));
    if (v) achadas.push({ iso: v, pos: m.index ?? 0 });
  }

  const extensa = /\b(\d{1,2})\s*[º°]?\s+de\s+([a-zA-ZçÇáéíóúâêôãõÁÉÍÓÚÂÊÔÃÕ]+)\s+de\s+(\d{4})\b/g;
  for (const m of texto.matchAll(extensa)) {
    const [, d, nomeMes, a] = m;
    if (!d || !nomeMes || !a) continue;
    const mes = MESES[semAcento(nomeMes).toLowerCase()];
    if (!mes) continue;
    const v = iso(Number(a), mes, Number(d));
    if (v) achadas.push({ iso: v, pos: m.index ?? 0 });
  }

  return achadas.sort((x, y) => x.pos - y.pos);
}

/**
 * Data mais próxima de um rótulo, olhando para os DOIS lados.
 *
 * O português jurídico usa as duas ordens, e olhar só para frente erra feio:
 *   - depois : "o executado foi citado em 22/04/2013"
 *   - antes  : "Em 05/03/2013, o Juízo determinou a citação"
 * Num despacho citatório essa confusão desloca o marco interruptivo do
 * art. 174 do CTN e pode inverter a conclusão sobre a prescrição.
 *
 * A janela para trás é mais curta: à frente o texto costuma emendar o próximo
 * evento, enquanto "Em <data>," gruda no verbo que vem logo em seguida.
 */
function dataPorRotulo(
  texto: string,
  datas: DataAchada[],
  rotulos: RegExp[],
  janelaFrente = 200,
  janelaAtras = 80,
): string | undefined {
  for (const rot of rotulos) {
    const re = new RegExp(rot.source, rot.flags.includes("g") ? rot.flags : `${rot.flags}g`);
    for (const m of texto.matchAll(re)) {
      const ini = m.index ?? 0;
      const fim = ini + m[0].length;

      let melhor: { iso: string; dist: number } | undefined;
      for (const d of datas) {
        const paraFrente = d.pos >= fim;
        const dist = paraFrente ? d.pos - fim : ini - (d.pos + 10); // 10 ≈ tamanho da data
        if (dist < 0) continue;
        if (dist > (paraFrente ? janelaFrente : janelaAtras)) continue;
        // A data tem de estar na MESMA frase do rótulo. Sem isto, "Fato gerador
        // em 01/01/2014. A constituição definitiva ocorreu em 15/03/2015"
        // atribuiria 01/01/2014 à constituição, por estar poucos caracteres
        // antes do rótulo.
        const entre = paraFrente ? texto.slice(fim, d.pos) : texto.slice(d.pos + 10, ini);
        if (fimDeFrase(entre)) continue;
        if (!melhor || dist < melhor.dist) melhor = { iso: d.iso, dist };
      }
      if (melhor) return melhor.iso;
    }
  }
  return undefined;
}

/**
 * Há quebra de frase no trecho? Ponto e ponto-e-vírgula encerram; uma quebra de
 * linha simples não, porque em documentos tabulados o rótulo e a data ficam em
 * linhas separadas ("Data da distribuição:\n10/02/2013").
 */
function fimDeFrase(trecho: string): boolean {
  return /[.;]|\n\s*\n/.test(trecho);
}

// ---------------------------------------------------------------------------
// Rótulos das datas-marco (o texto é normalizado sem acento antes de casar)
// ---------------------------------------------------------------------------

const ROTULOS_DATA: { chave: string; nome: string; padroes: RegExp[] }[] = [
  {
    chave: "dataFatoGerador",
    nome: "Fato gerador",
    padroes: [/fato\s+gerador/i, /competencia\s+do\s+tributo/i, /exercicio\s+de\s+referencia/i],
  },
  {
    chave: "dataConstituicaoDefinitiva",
    nome: "Constituição definitiva do crédito",
    padroes: [
      /constituicao\s+definitiva/i,
      /credito\s+definitivamente\s+constituido/i,
      /entrega\s+da\s+declaracao/i,
      /vencimento\s+d[oa]\s+(?:tributo|credito|debito)/i,
    ],
  },
  {
    chave: "dataNotificacao",
    nome: "Notificação do lançamento",
    padroes: [/notificacao\s+d[oa]\s+lancamento/i, /notificad[oa]\s+(?:o\s+)?sujeito\s+passivo/i],
  },
  {
    chave: "dataInscricaoDividaAtiva",
    nome: "Inscrição em dívida ativa",
    padroes: [/inscricao\s+(?:em|na)\s+divida\s+ativa/i, /inscrit[oa]\s+em\s+divida\s+ativa/i, /data\s+d[ae]\s+inscricao/i],
  },
  {
    chave: "dataAjuizamento",
    nome: "Ajuizamento / distribuição",
    padroes: [/data\s+d[ae]\s+distribuicao/i, /distribuid[oa]\s+em/i, /ajuizad[oa]\s+em/i, /ajuizamento/i, /protocolizad[oa]\s+em/i],
  },
  {
    chave: "dataDespachoCitatorio",
    nome: "Despacho citatório",
    // determinou / determinada / determinado / ordenou / ordenada …
    padroes: [/despacho\s+citatorio/i, /cite-?se/i, /determin\w*\s+a\s+citacao/i, /orden\w*\s+a\s+citacao/i],
  },
  {
    chave: "dataCitacao",
    nome: "Citação do executado",
    padroes: [/citad[oa]\s+em/i, /citacao\s+(?:realizada|efetivada|cumprida|positiva)\s*(?:em)?/i, /mandado\s+de\s+citacao\s+cumprido/i],
  },
];

// ---------------------------------------------------------------------------
// Identificação
// ---------------------------------------------------------------------------

const RE_PROCESSO = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/;
const RE_CNPJ = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/;
const RE_CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/;

const TRIBUTOS = [
  "IPTU", "ISS", "ISSQN", "ICMS", "IPVA", "ITBI", "ITCMD", "IRPJ", "IRPF",
  "CSLL", "COFINS", "PIS", "PASEP", "INSS", "ITR", "IOF", "IPI", "CIDE", "FGTS",
];

/** Captura o valor de um rótulo do tipo "EXEQUENTE: Fazenda Pública ...". */
function porRotulo(texto: string, rotulos: string[], max = 120): string | undefined {
  for (const r of rotulos) {
    const re = new RegExp(`${r}\\s*:?\\s*([^\\n\\r]{3,${max}})`, "i");
    const m = re.exec(texto);
    const bruto = m?.[1];
    if (!bruto) continue;
    // Corta no próximo rótulo/documento que costuma vir na mesma linha.
    const limpo = bruto
      .split(/\s{3,}|\b(?:CPF|CNPJ|EXECUTAD|EXEQUENT|REQUERID|REQUERENT|ADVOGAD|OAB)\b/i)[0]
      ?.replace(/[\s.;,–-]+$/, "")
      .trim();
    if (limpo && limpo.length >= 3) return limpo;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------

export function extrairDadosProcesso(textoOriginal: string): DadosExtraidos {
  const texto = textoOriginal.slice(0, 400_000);
  // Versão sem acento para casar rótulos; as posições coincidem porque a
  // normalização NFD+remoção de diacríticos preserva o comprimento das letras
  // base. Para segurança, as datas são buscadas no texto sem acento também.
  const plano = semAcento(texto);
  const datas = todasAsDatas(plano);

  const out: DadosExtraidos = { facts: {}, encontrados: [], ausentes: [] };

  const processo = RE_PROCESSO.exec(texto)?.[0];
  if (processo) {
    out.processNumber = processo;
    out.encontrados.push(`Processo nº ${processo}`);
  } else {
    out.ausentes.push("Número do processo (padrão CNJ)");
  }

  const exequente = porRotulo(texto, ["EXEQUENTE", "REQUERENTE", "EXCEPT[OA]", "AUTOR"]);
  if (exequente) {
    out.creditor = exequente;
    out.encontrados.push(`Exequente: ${exequente}`);
  } else {
    out.ausentes.push("Exequente (Fazenda Pública)");
  }

  const executado = porRotulo(texto, ["EXECUTAD[OA]", "REQUERID[OA]", "EXCIPIENTE", "REU"]);
  if (executado) {
    out.debtor = executado;
    out.encontrados.push(`Executado: ${executado}`);
  } else {
    out.ausentes.push("Executado");
  }

  const doc = RE_CNPJ.exec(texto)?.[0] ?? RE_CPF.exec(texto)?.[0];
  if (doc) {
    out.debtorDocument = doc;
    out.encontrados.push(`CPF/CNPJ: ${doc}`);
  }

  const comarca = /COMARCA\s+DE\s+([A-ZÀ-Ú][^\n\r,.;]{2,60})/i.exec(texto)?.[1]?.trim();
  if (comarca) {
    out.jurisdiction = comarca;
    out.encontrados.push(`Comarca: ${comarca}`);
  }

  const vara = /(\d+[ªº]?\s*VARA[^\n\r,.;]{0,60})/i.exec(texto)?.[1]?.trim();
  if (vara) {
    out.courtDivision = vara;
    out.encontrados.push(`Vara: ${vara}`);
  }

  const tribunal = /TRIBUNAL\s+DE\s+JUSTI[ÇC]A\s+D[OE]\s+([^\n\r,.;]{2,60})/i.exec(texto)?.[1]?.trim();
  if (tribunal) out.court = `Tribunal de Justiça de ${tribunal}`;

  const cda =
    /\bCDA\s*n?[º°]?\s*[:.]?\s*([\d][\d./-]{3,28})/i.exec(texto)?.[1] ??
    /certid[ãa]o\s+de\s+d[íi]vida\s+ativa\s*n?[º°]?\s*[:.]?\s*([\d][\d./-]{3,28})/i.exec(texto)?.[1];
  if (cda) {
    out.cdaNumber = cda.replace(/[.;,-]+$/, "");
    out.encontrados.push(`CDA nº ${out.cdaNumber}`);
  } else {
    out.ausentes.push("Número da CDA");
  }

  const tributo = TRIBUTOS.find((t) => new RegExp(`\\b${t}\\b`).test(texto.toUpperCase()));
  if (tributo) {
    out.taxType = tributo;
    out.encontrados.push(`Tributo: ${tributo}`);
  }

  // Datas-marco.
  for (const { chave, nome, padroes } of ROTULOS_DATA) {
    const valor = dataPorRotulo(plano, datas, padroes);
    if (valor) {
      out.facts[chave] = valor;
      out.encontrados.push(`${nome}: ${brasileira(valor)}`);
    } else {
      out.ausentes.push(nome);
    }
  }

  // Condições processuais NÃO são deduzidas por menção no texto: uma citação da
  // palavra "penhora" num modelo não prova que houve penhora, e um falso
  // positivo aqui pode SUPRIMIR uma tese de prescrição. Ficam para conferência.
  out.ausentes.push("Parcelamento, penhora, suspensão e arquivamento (confirmar nos autos)");

  return out;
}

/** AAAA-MM-DD → DD/MM/AAAA, para exibição. */
export function brasileira(isoDate: string): string {
  const [a, m, d] = isoDate.split("-");
  return a && m && d ? `${d}/${m}/${a}` : isoDate;
}

/** Título sugerido para a análise, a partir do que foi lido. */
export function tituloSugerido(dados: DadosExtraidos, nomeArquivo: string): string {
  if (dados.processNumber) return `Execução fiscal ${dados.processNumber}`;
  if (dados.debtor) return `Execução fiscal — ${dados.debtor}`.slice(0, 200);
  const base = nomeArquivo.replace(/\.[a-z0-9]+$/i, "").trim();
  return (base.length >= 3 ? `Análise — ${base}` : "Análise automática").slice(0, 200);
}
