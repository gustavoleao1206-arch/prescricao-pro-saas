import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "./env";

const exec = promisify(execFile);

/**
 * OCR de PDF digitalizado.
 *
 * Cópias integrais de execução fiscal saem dos sistemas processuais como
 * imagem: o único texto é o carimbo de cabeçalho. Sem OCR o sistema lê ~13%
 * de um processo e pode concluir "não há registro de parcelamento" sobre
 * páginas que nunca viu — e parcelamento interrompe a prescrição (art. 174,
 * parágrafo único, IV, do CTN). Por isso isto não é conveniência: é correção
 * da conclusão.
 *
 * Estratégia: Ghostscript rasteriza as páginas, Tesseract lê em português.
 * Ambos são binários externos — quando faltam, `ocrDisponivel()` devolve false
 * e a extração segue sem OCR, sinalizando o documento como digitalizado.
 */

export interface PaginaOcr {
  page: number;
  text: string;
}

export interface ResultadoOcr {
  paginas: PaginaOcr[];
  paginasLidas: number;
  paginasNoDocumento: number;
  truncado: boolean;
}

/**
 * ⚠️ TETOS DE TEMPO — nenhuma execução externa pode esperar para sempre.
 *
 * Nenhuma das chamadas tinha `timeout`, e `execFile` sem `timeout` espera indefinidamente. Em produção o
 * OCR roda DENTRO do processo Node que serve o site, numa instância única: um PDF que faça o Ghostscript
 * entrar em laço prende a máquina que atende todos os clientes pagantes. Pior, o `maxDuration` do Next
 * encerra a RESPOSTA mas não mata o processo filho — o Ghostscript continuava consumindo CPU depois de o
 * cliente já ter visto erro na tela, e nada no código o recolhia.
 *
 * `killSignal: "SIGKILL"` porque processo que ignora o encerramento normal precisa ser derrubado.
 *
 * Os números são ponto de partida deliberadamente generoso, calibrados pelo que o próprio código já
 * registrava (~1-2s por página; 166 páginas custavam minutos) e pelo teto de 300s da requisição: acima
 * disso o trabalho já estava perdido de qualquer forma.
 */
const TETO_VERIFICACAO_MS = 15_000;
const TETO_RASTERIZACAO_MS = 240_000;
const TETO_POR_PAGINA_MS = 45_000;
/** Orçamento total: passado dele, para de transcrever e entrega o que já leu. */
const PRAZO_TOTAL_MS = 270_000;

/**
 * Lado da caixa de rasterização, em pixels.
 *
 * ── O defeito aritmético que isto conserta ────────────────────────────────────
 * `-r300` era aplicado ao tamanho de página que o PRÓPRIO ARQUIVO DO CLIENTE declara, sem teto. Um PDF de
 * UMA página que declare tamanho absurdo virava uma imagem de bilhões de pixels — e a instância tem 512 MB.
 * Um arquivo, uma página, site fora do ar.
 *
 * A caixa é QUADRADA e do tamanho do lado maior de um A4 no DPI configurado, combinada com `-dPDFFitPage`.
 * Por que quadrada: `-dPDFFitPage` preserva a proporção, então A4 em pé encosta na altura e A4 deitado
 * encosta na largura — os dois rasterizam nos mesmos 300 DPI de hoje, sem perder qualidade em nenhuma
 * orientação. Uma caixa retangular em pé encolheria toda página deitada, e tabela de cálculo de débito
 * fiscal em paisagem é comum. Página maior que A4 (planta, A3) é REDUZIDA para caber, não cortada:
 * perde resolução, nunca conteúdo.
 */
export function ladoDaCaixa(dpi: number): number {
  const A4_MAIOR_LADO_MM = 297;
  return Math.round((A4_MAIOR_LADO_MM / 25.4) * dpi);
}

/**
 * Argumentos da rasterização — função pura, para poder ser conferida por teste.
 *
 * ── Por que isto é uma função separada ────────────────────────────────────────
 * Ghostscript e Tesseract não estão instalados na máquina de desenvolvimento (e a suíte pula os testes de
 * OCR quando faltam). Sem isto, a única forma de saber se `-dSAFER` continua na lista seria publicar em
 * produção e esperar. Com a lista de argumentos numa função pura, o teste confere a DECISÃO sem precisar
 * do binário — e o que o binário faz com ela é conferido por quem tem os arquivos reais.
 *
 * ── Por que `-dSAFER` aqui não corre o risco que corria na contagem de páginas ─
 * O `-dNOSAFER` da contagem existia por um motivo técnico: aquele código abria o arquivo em TEMPO DE
 * EXECUÇÃO, por dentro de um trecho PostScript (`(caminho) (r) file`), e é exatamente isso que o SAFER
 * bloqueia. Aqui o arquivo entra como ARGUMENTO da linha de comando, caso que o SAFER permite desde
 * sempre. Foi por isso que apagar aquela função eliminou a necessidade do `-dNOSAFER` em vez de apenas
 * mudar a opção.
 */
export function argumentosDeRasterizacao(opcoes: {
  entrada: string;
  saida: string;
  ate: number;
  dpi: number;
  /** `false` na segunda tentativa — ver `rasterizar`. */
  comCaixa: boolean;
}): string[] {
  const lado = ladoDaCaixa(opcoes.dpi);
  return [
    "-q",
    "-dSAFER",
    "-dNOPAUSE",
    "-dBATCH",
    "-sDEVICE=png16m",
    `-r${opcoes.dpi}`,
    ...(opcoes.comCaixa ? [`-g${lado}x${lado}`, "-dPDFFitPage"] : []),
    "-dFirstPage=1",
    `-dLastPage=${opcoes.ate}`,
    `-sOutputFile=${opcoes.saida}`,
    opcoes.entrada,
  ];
}

let disponivelCache: boolean | null = null;

/** Ghostscript e Tesseract estão instalados e com o idioma português? */
export async function ocrDisponivel(): Promise<boolean> {
  if (disponivelCache !== null) return disponivelCache;
  if (!env.ocr.enabled) return (disponivelCache = false);
  try {
    await exec(env.ocr.ghostscriptBin, ["--version"], { timeout: TETO_VERIFICACAO_MS, killSignal: "SIGKILL" });
    const { stdout } = await exec(env.ocr.tesseractBin, ["--list-langs"], {
      timeout: TETO_VERIFICACAO_MS,
      killSignal: "SIGKILL",
    });
    disponivelCache = stdout.split(/\r?\n/).some((l) => l.trim() === env.ocr.lang);
  } catch {
    disponivelCache = false;
  }
  return disponivelCache;
}

/**
 * Rasteriza e transcreve o PDF. Devolve apenas as páginas com texto útil.
 *
 * `maxPaginas` limita o tempo total: cada página custa ~1-2s, então um processo
 * de 300 páginas levaria mais que o teto da requisição. Quando corta, avisa
 * pelo campo `truncado` para o chamador registrar a lacuna.
 */
export async function ocrPdf(
  pdf: Buffer,
  /**
   * Total de páginas, JÁ CONHECIDO por quem chama.
   *
   * ── Por que isto virou parâmetro (achado crítico da auditoria) ──────────────
   * Antes, o total vinha de uma função `contarPaginas` que executava o Ghostscript com `-dNOSAFER` — o
   * oposto de `-dSAFER`, ou seja, com a proteção que impede o interpretador de ler e escrever arquivos da
   * máquina DESLIGADA de propósito. E era a PRIMEIRA coisa a rodar sobre o PDF do cliente.
   *
   * Alcançar aquele código era trivial: bastava o PDF não ter camada de texto, o que todo documento
   * escaneado satisfaz. Ao alcance do processo estavam as variáveis do serviço — a chave que decifra os
   * CPF/CNPJ, a chave de cobrança do Asaas em produção, as credenciais do bucket com as cópias dos
   * processos e a `DATABASE_URL`.
   *
   * A função foi APAGADA, não corrigida. Trocar por `-dSAFER` fecharia o furo, mas manteria uma execução
   * de Ghostscript por documento para obter um número que o chamador já tem de graça: o `unpdf` devolve
   * `totalPages` antes de decidir chamar o OCR. Menos código externo rodando sobre arquivo hostil é uma
   * defesa melhor do que mais opções de segurança em código que não precisava existir.
   */
  totalPaginas: number,
  maxPaginas = env.ocr.maxPaginas,
): Promise<ResultadoOcr> {
  const vazio: ResultadoOcr = { paginas: [], paginasLidas: 0, paginasNoDocumento: 0, truncado: false };
  const dir = await mkdtemp(join(tmpdir(), "ptp-ocr-"));
  const limite = Date.now() + PRAZO_TOTAL_MS;
  try {
    const entrada = join(dir, "entrada.pdf");
    await writeFile(entrada, pdf);

    // Arquivo corrompido ou que não é PDF: devolve vazio em vez de lançar. Quem
    // chama já extraiu as páginas nativas, e uma exceção aqui as descartaria.
    const total = Number.isFinite(totalPaginas) && totalPaginas > 0 ? Math.floor(totalPaginas) : 0;
    if (total === 0) return vazio;
    const ate = Math.min(total, maxPaginas);

    // Uma chamada do Ghostscript para todas as páginas: abrir o PDF por página
    // custa mais que rasterizar tudo de uma vez.
    const rasterizacaoIncompleta = await rasterizar({ dir, entrada, ate });

    const imagens = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    if (imagens.length === 0) return vazio;

    // Transcrição em PARALELO com teto de concorrência. Cada página é um
    // processo Tesseract independente; em série, 166 páginas custavam minutos
    // e era isso que segurava o "Lendo o processo…" no envio. O pool consome a
    // fila compartilhando um índice, e o resultado é ordenado ao final para o
    // texto não depender de qual página terminou primeiro.
    const paginas: PaginaOcr[] = [];
    let proximo = 0;
    let prazoEstourado = false;
    async function transcritor(): Promise<void> {
      while (proximo < imagens.length) {
        /**
         * Orçamento total: para de pegar página nova quando o tempo acaba.
         *
         * Sem isto, um documento grande continuaria consumindo CPU depois de a requisição já ter
         * expirado — trabalho jogado fora que competia com o atendimento de quem ainda estava no site.
         */
        if (Date.now() > limite) {
          prazoEstourado = true;
          return;
        }
        const img = imagens[proximo++]!;
        const n = Number(/p(\d+)\.png$/.exec(img)?.[1] ?? 0);
        if (!n) continue;
        try {
          const { stdout } = await exec(
            env.ocr.tesseractBin,
            [join(dir, img), "stdout", "-l", env.ocr.lang, "--psm", "3"],
            { maxBuffer: 16 * 1024 * 1024, timeout: TETO_POR_PAGINA_MS, killSignal: "SIGKILL" },
          );
          const texto = stdout.trim();
          if (texto.length > 0) paginas.push({ page: n, text: texto });
        } catch {
          // Página ilegível (imagem ruim, girada, tabela densa): segue adiante.
          // Perder uma página é melhor do que abortar a transcrição inteira.
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(env.ocr.concorrencia, imagens.length) || 1 }, () => transcritor()),
    );
    paginas.sort((a, b) => a.page - b.page);

    return {
      paginas,
      paginasLidas: paginas.length,
      paginasNoDocumento: total,
      /** Truncado por qualquer um dos três motivos — o chamador só precisa saber que falta página. */
      truncado: total > ate || rasterizacaoIncompleta || prazoEstourado,
    };
  } catch {
    // Ghostscript pode falhar em PDF protegido, corrompido ou com recurso não
    // suportado. Degrada para "sem OCR" — o chamador segue com o texto nativo.
    return vazio;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Rasteriza as páginas. Devolve `true` quando ficou incompleta.
 *
 * ── Duas tentativas, e o motivo é honestidade sobre o que não pude testar ─────
 * As opções `-g` e `-dPDFFitPage` existem para conter um problema aritmético real: o `-r300` era aplicado
 * ao tamanho de página que o ARQUIVO DO CLIENTE declara, então um PDF de uma página com tamanho absurdo
 * virava uma imagem de bilhões de pixels numa instância de 512 MB.
 *
 * Só que não há Ghostscript na máquina onde isto foi escrito, e o efeito dessas opções sobre processo
 * escaneado real não pôde ser medido. Se elas fizerem o Ghostscript recusar o arquivo, o OCR silenciaria e
 * TODO processo digitalizado passaria a ser recusado como ilegível — o exato defeito que o OCR existe para
 * consertar, e sem erro no log, só análise recusada.
 *
 * Então: se a primeira tentativa não produzir imagem NENHUMA, tenta de novo sem a caixa e registra o
 * aviso. O pior caso de um palpite errado meu passa a ser o comportamento de hoje mais uma linha de log —
 * e não cliente pagante recebendo "não consegui ler" na cópia do processo. `-dSAFER` fica nas duas.
 */
async function rasterizar(p: { dir: string; entrada: string; ate: number }): Promise<boolean> {
  const saida = join(p.dir, "p%04d.png");
  const base = { entrada: p.entrada, saida, ate: p.ate, dpi: env.ocr.dpi };
  const opcoesDeExecucao = {
    maxBuffer: 64 * 1024 * 1024,
    timeout: TETO_RASTERIZACAO_MS,
    killSignal: "SIGKILL" as const,
  };

  let incompleta = false;
  try {
    await exec(env.ocr.ghostscriptBin, argumentosDeRasterizacao({ ...base, comCaixa: true }), opcoesDeExecucao);
  } catch {
    /**
     * Falha aqui NÃO descarta o que já saiu: o Ghostscript escreve página por página, então quando o
     * tempo estoura já existem PNGs. Antes, qualquer erro devolvia vazio — o cliente via "não consegui
     * ler" num arquivo do qual 180 de 200 páginas já tinham sido rasterizadas.
     */
    incompleta = true;
  }

  const saiuAlgo = (await readdir(p.dir)).some((f) => f.endsWith(".png"));
  if (saiuAlgo) return incompleta;

  console.error(
    "[ocr] rasterização não produziu imagem com a caixa de tamanho fixo; repetindo sem ela. " +
      "Se este aviso aparecer em produção, as opções -g/-dPDFFitPage são incompatíveis com o " +
      "Ghostscript instalado e devem ser revistas (a proteção contra página gigante fica inativa).",
  );
  try {
    await exec(env.ocr.ghostscriptBin, argumentosDeRasterizacao({ ...base, comCaixa: false }), opcoesDeExecucao);
    return incompleta;
  } catch {
    return true;
  }
}

/** Reinicia a checagem de disponibilidade (usado em teste). */
export function resetOcrCache(): void {
  disponivelCache = null;
}
