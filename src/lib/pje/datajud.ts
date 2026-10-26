/**
 * Cliente da API Pública do DataJud (CNJ).
 *
 * Canal **oficial** do CNJ para consulta automatizada de metadados
 * processuais (Resolução CNJ nº 331/2020). Não exige credencial pessoal,
 * não passa por CAPTCHA e não contorna nenhum controle de acesso: a chave
 * pública é publicada pelo próprio CNJ na documentação da API.
 *
 * ## O que esta API devolve — e o que não devolve
 *
 * Devolve: número do processo, tribunal, grau, órgão julgador, classe,
 * assuntos, data de ajuizamento, nível de sigilo e a **lista completa de
 * movimentos** com código e data.
 *
 * **Não devolve dado pessoal.** Não há nome de parte, CPF, CNPJ, endereço
 * nem nome de advogado no índice público — verificado empiricamente contra
 * `api_publica_trf5` em 27/07/2026. Por consequência:
 *
 *   1. Não é possível pesquisar processo por CPF aqui. A chave de entrada é
 *      o **número CNJ do processo**.
 *   2. O módulo não trata dado pessoal, o que dispensa base legal de
 *      tratamento e satisfaz a minimização do art. 6º, III da LGPD por
 *      construção, e não por controle adicionado depois.
 *
 * Os movimentos são o insumo que interessa à análise de prescrição: as datas
 * de despacho citatório, suspensão e arquivamento (art. 40 da LEF) saem
 * daqui sem depender de leitura de PDF.
 */

import { env } from "../env";

const BASE_URL = "https://api-publica.datajud.cnj.jus.br";

/** Segmentos do Judiciário — dígito `J` do número CNJ (Res. CNJ nº 65/2008). */
const SEGMENTO_FEDERAL = "4";
const SEGMENTO_ESTADUAL = "8";

/** Código `TR` → sigla da UF, na ordem alfabética adotada pelo CNJ. */
const UF_POR_CODIGO: Record<string, string> = {
  "01": "ac", "02": "al", "03": "ap", "04": "am", "05": "ba", "06": "ce",
  "07": "df", "08": "es", "09": "go", "10": "ma", "11": "mt", "12": "ms",
  "13": "mg", "14": "pa", "15": "pb", "16": "pr", "17": "pe", "18": "pi",
  "19": "rj", "20": "rn", "21": "rs", "22": "ro", "23": "rr", "24": "sc",
  "25": "se", "26": "sp", "27": "to",
};

export interface MovimentoProcessual {
  codigo: number;
  nome: string;
  dataHora: Date;
  orgaoJulgador?: string;
}

export interface ProcessoDataJud {
  numero: string;
  numeroFormatado: string;
  tribunal: string;
  grau: string;
  orgaoJulgador: string;
  classe: string;
  assuntos: string[];
  dataAjuizamento: Date | null;
  nivelSigilo: number;
  movimentos: MovimentoProcessual[];
}

export class DataJudError extends Error {
  constructor(
    message: string,
    readonly codigo:
      | "NUMERO_INVALIDO"
      | "TRIBUNAL_NAO_SUPORTADO"
      | "NAO_ENCONTRADO"
      | "INDISPONIVEL"
      /** Falta configuração deste ambiente — não é falha do CNJ, e a ação é outra. */
      | "SEM_CREDENCIAL",
  ) {
    super(message);
    this.name = "DataJudError";
  }
}

/** Remove máscara e deixa só os 20 dígitos do número CNJ. */
export function normalizarNumero(numero: string): string {
  return numero.replace(/\D/g, "");
}

/**
 * Valida o número CNJ pelo dígito verificador (ISO 7064, módulo 97 base 10).
 *
 * Formato: `NNNNNNN-DD.AAAA.J.TR.OOOO`. O dígito correto satisfaz
 * `(NNNNNNN AAAA J TR OOOO DD) mod 97 === 1`.
 *
 * Validar antes de sair para a rede evita queimar requisição com número
 * digitado errado — e erro de digitação em número de 20 dígitos é a regra,
 * não a exceção.
 */
export function validarNumeroCNJ(numero: string): boolean {
  const d = normalizarNumero(numero);
  if (d.length !== 20) return false;

  const sequencial = d.slice(0, 7);
  const verificador = d.slice(7, 9);
  const resto = d.slice(9); // AAAA J TR OOOO

  return BigInt(`${sequencial}${resto}${verificador}`) % 97n === 1n;
}

/** Aplica a máscara `NNNNNNN-DD.AAAA.J.TR.OOOO`. */
export function formatarNumero(numero: string): string {
  const d = normalizarNumero(numero);
  if (d.length !== 20) return numero;
  return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16)}`;
}

/**
 * Descobre o índice do tribunal a partir do próprio número do processo.
 *
 * Cada tribunal tem seu índice na API (`api_publica_tjsp`, `api_publica_trf5`
 * etc.), e os dígitos `J` e `TR` já dizem qual é — não é preciso perguntar o
 * tribunal ao usuário.
 */
export function resolverIndice(numero: string): string {
  const d = normalizarNumero(numero);
  const segmento = d.slice(13, 14);
  const tr = d.slice(14, 16);

  if (segmento === SEGMENTO_FEDERAL) {
    const regiao = Number(tr);
    if (regiao >= 1 && regiao <= 6) return `api_publica_trf${regiao}`;
    throw new DataJudError(`Região federal desconhecida: ${tr}`, "TRIBUNAL_NAO_SUPORTADO");
  }

  if (segmento === SEGMENTO_ESTADUAL) {
    const uf = UF_POR_CODIGO[tr];
    if (uf) return `api_publica_tj${uf}`;
    throw new DataJudError(`Tribunal estadual desconhecido: ${tr}`, "TRIBUNAL_NAO_SUPORTADO");
  }

  throw new DataJudError(
    `Segmento ${segmento} não coberto. A plataforma trata execução fiscal, ` +
      `que corre na Justiça Estadual (8) ou Federal (4).`,
    "TRIBUNAL_NAO_SUPORTADO",
  );
}

/**
 * `dataAjuizamento` vem como string `yyyyMMddHHmmss` — não é ISO, e
 * `new Date()` a interpreta errado em silêncio. Os movimentos, por outro
 * lado, vêm em ISO 8601. Daí as duas rotinas separadas.
 */
function parseDataCompacta(valor: unknown): Date | null {
  if (typeof valor !== "string" || valor.length < 8) return null;
  const iso =
    `${valor.slice(0, 4)}-${valor.slice(4, 6)}-${valor.slice(6, 8)}T` +
    `${valor.slice(8, 10) || "00"}:${valor.slice(10, 12) || "00"}:${valor.slice(12, 14) || "00"}Z`;
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? null : data;
}

function mapearMovimentos(bruto: unknown): MovimentoProcessual[] {
  if (!Array.isArray(bruto)) return [];

  return bruto
    .map((m): MovimentoProcessual | null => {
      const data = new Date(m?.dataHora);
      if (Number.isNaN(data.getTime())) return null;
      return {
        codigo: Number(m.codigo),
        nome: String(m.nome ?? ""),
        dataHora: data,
        orgaoJulgador: m?.orgaoJulgador?.nome ?? undefined,
      };
    })
    .filter((m): m is MovimentoProcessual => m !== null)
    .sort((a, b) => a.dataHora.getTime() - b.dataHora.getTime());
}

/**
 * Consulta um processo pelo número CNJ.
 *
 * Uma requisição, um processo. Não existe varredura por assunto, por parte
 * nem por intervalo de datas nesta camada — quem informa o número é quem já
 * tem acesso legítimo àquele processo, e essa é a garantia que sustenta o
 * desenho.
 *
 * @returns o processo, ou `null` se não constar no índice.
 */
export async function consultarProcesso(
  numero: string,
  opcoes: { signal?: AbortSignal } = {},
): Promise<ProcessoDataJud | null> {
  if (!validarNumeroCNJ(numero)) {
    throw new DataJudError(
      "Número de processo inválido: o dígito verificador não confere.",
      "NUMERO_INVALIDO",
    );
  }

  /**
   * ⚠️ Sem chave configurada, recusa ANTES de chamar o CNJ.
   *
   * A chave tinha um valor escrito em `env.ts` como padrão, e esse padrão era empacotado no JavaScript do
   * navegador junto com o resto do módulo de ambiente. Ela saiu de lá; aqui entra a guarda que faltava,
   * porque sem ela a requisição partiria com `APIKey ` vazio e o CNJ devolveria 401 — erro de rede
   * genérico, difícil de diagnosticar, em vez de "falta configurar".
   */
  if (!env.datajud.apiKey) {
    throw new DataJudError(
      "Consulta ao DataJud indisponível: a variável DATAJUD_API_KEY não está configurada neste ambiente.",
      "SEM_CREDENCIAL",
    );
  }

  const indice = resolverIndice(numero);
  const digitos = normalizarNumero(numero);

  let resposta: Response;
  try {
    resposta = await fetch(`${BASE_URL}/${indice}/_search`, {
      method: "POST",
      headers: {
        Authorization: `APIKey ${env.datajud.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        size: 1,
        query: { match: { numeroProcesso: digitos } },
      }),
      signal: opcoes.signal,
    });
  } catch (erro) {
    throw new DataJudError(
      `Falha de rede ao consultar o DataJud: ${(erro as Error).message}`,
      "INDISPONIVEL",
    );
  }

  if (!resposta.ok) {
    throw new DataJudError(
      `DataJud respondeu ${resposta.status} para o índice ${indice}.`,
      "INDISPONIVEL",
    );
  }

  const dados = await resposta.json();
  const fonte = dados?.hits?.hits?.[0]?._source;
  if (!fonte) return null;

  return {
    numero: digitos,
    numeroFormatado: formatarNumero(digitos),
    tribunal: String(fonte.tribunal ?? ""),
    grau: String(fonte.grau ?? ""),
    orgaoJulgador: String(fonte.orgaoJulgador?.nome ?? ""),
    classe: String(fonte.classe?.nome ?? ""),
    assuntos: Array.isArray(fonte.assuntos)
      ? fonte.assuntos.map((a: { nome?: string }) => String(a?.nome ?? "")).filter(Boolean)
      : [],
    dataAjuizamento: parseDataCompacta(fonte.dataAjuizamento),
    nivelSigilo: Number(fonte.nivelSigilo ?? 0),
    movimentos: mapearMovimentos(fonte.movimentos),
  };
}
