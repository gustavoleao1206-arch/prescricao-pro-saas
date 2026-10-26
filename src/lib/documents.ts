import { sha256 } from "./crypto";
import { env } from "./env";
import { ocrDisponivel, ocrPdf } from "./ocr";

/**
 * Processamento de documentos: checksum (para detectar duplicidade) e extração
 * de texto. PDFs pesquisáveis são extraídos com unpdf. DOCX/imagens exigem
 * bibliotecas adicionais (mammoth / OCR) — marcados como pendentes e sinalizados
 * como "ilegível" para que a análise aponte a ausência (nunca inventa conteúdo).
 */

export interface ExtractedPage {
  page: number;
  text: string;
  legible: boolean;
}

export interface ExtractionResult {
  pageCount: number;
  pages: ExtractedPage[];
  ocrApplied: boolean;
  note?: string;
  /** Páginas com conteúdo real (acima do carimbo de cabeçalho/numeração). */
  paginasComTexto: number;
}

/**
 * Mínimo de caracteres para uma página contar como legível.
 *
 * PDFs digitalizados de sistemas processuais NÃO vêm sem texto: cada página
 * carrega o carimbo do e-proc e a numeração ("1/2", "fl. 37"). Contar isso como
 * "tem texto" faz o sistema achar que leu o processo e devolver uma análise
 * vazia — foi o que acontecia com o limiar ausente.
 *
 * O valor veio de medição, não de estimativa. Num processo real de 166 páginas
 * digitalizadas a distribuição é bimodal: página é carimbo (mediana de 6
 * caracteres) ou é conteúdo (mais de 200). Entre 25 e 200 o resultado é
 * idêntico — 22 páginas legíveis —, então o limiar alto não comprava precisão
 * e cobrava caro: um despacho curto de verdade ("Cite-se. Maceió, 05/03/2011")
 * tem ~40 caracteres e era descartado como ilegível.
 */
/**
 * A partir de quantos caracteres uma página conta como "tem texto". Abaixo disso é só o carimbo do
 * sistema processual. Exportada porque o motor de análise usa o mesmo corte para decidir se há o que
 * analisar ANTES de cobrar — ver `analysis-runner.ts`.
 */
export const MIN_CHARS_PAGINA = 60;

export type DiagnosticoLeitura = "legivel" | "parcial" | "digitalizado";

/**
 * Classifica o quanto do documento é aproveitável.
 * - digitalizado: menos de 20% das páginas têm texto — não dá para analisar.
 * - parcial: entre 20% e 60% — dá para analisar, mas com lacunas.
 * - legivel: acima de 60%.
 */
export function diagnosticarLeitura(r: ExtractionResult): DiagnosticoLeitura {
  const total = Math.max(r.pageCount, r.pages.length, 1);
  const proporcao = r.paginasComTexto / total;
  if (r.paginasComTexto === 0 || proporcao < 0.2) return "digitalizado";
  if (proporcao < 0.6) return "parcial";
  return "legivel";
}

export function computeChecksum(data: Buffer): string {
  return sha256(data);
}

/**
 * Formatos que `extractText` REALMENTE processa — a autoridade final do que pode
 * ser enviado.
 *
 * `UPLOAD_ALLOWED_MIME` é configuração e pode estar errada: o `.env` deste projeto
 * (e o `.env.example` que o copiou) listava DOCX e XLSX. Com isso, o upload
 * ACEITAVA o arquivo e a extração devolvia zero página — o cliente enviava a peça,
 * via "documento recebido" e a análise concluía sobre nada. Pior: os documentos
 * legais publicam a lista de formatos aceitos, e um contrato que anuncia formato
 * que a Plataforma não lê é oferta que vincula o fornecedor (arts. 30 e 37 do CDC).
 *
 * A regra passou a ser a INTERSEÇÃO: o formato precisa estar na configuração E
 * aqui. Configuração generosa demais não gera mais upload inútil, e implementar a
 * leitura de um novo formato exige acrescentá-lo nesta lista — no mesmo arquivo em
 * que a leitura é escrita.
 */
export const MIME_PROCESSAVEIS = ["application/pdf", "image/png", "image/jpeg"] as const;

/**
 * Nome comercial de cada formato processável.
 *
 * Mora aqui, junto de `MIME_PROCESSAVEIS`, porque cinco documentos legais publicam
 * essa lista. Cada um mantinha o próprio mapa de rótulos, com fallback que imprimia
 * o MIME cru — bastava a extração passar a ler um formato novo para um contrato de
 * adesão publicar "application/vnd.openxmlformats-officedocument..." no meio do
 * texto, ou anunciar menos formatos do que o envio aceita. Acrescentar formato agora
 * exige mexer neste arquivo, que é onde a leitura dele é escrita.
 */
const ROTULO_MIME: Record<string, string> = {
  "application/pdf": "PDF",
  "image/png": "PNG",
  "image/jpeg": "JPEG",
};

/** Formatos aceitos com nome de gente, para uso nos textos públicos. */
export function rotulosDosFormatos(): string[] {
  return formatosAceitos()
    .map((m) => ROTULO_MIME[m])
    .filter((r): r is string => Boolean(r));
}

/** Formatos efetivamente aceitos: configurados E processáveis. */
export function formatosAceitos(): string[] {
  return env.upload.allowedMime
    .map((m) => m.trim())
    .filter((m) => (MIME_PROCESSAVEIS as readonly string[]).includes(m));
}

export function validateUpload(mime: string, sizeBytes: number): string | null {
  if (!formatosAceitos().includes(mime)) {
    return `Formato não aceito (${mime}).`;
  }
  const maxBytes = env.upload.maxFileMb * 1024 * 1024;
  if (sizeBytes > maxBytes) {
    return `Arquivo excede o limite de ${env.upload.maxFileMb} MB.`;
  }
  return null;
}

/**
 * Assinatura de cada formato — os primeiros bytes que o arquivo REALMENTE tem.
 *
 * `%PDF-` para PDF, o cabeçalho de 8 bytes do PNG, e `FF D8 FF` para JPEG.
 */
const ASSINATURAS: Record<string, readonly number[][]> = {
  "application/pdf": [[0x25, 0x50, 0x44, 0x46, 0x2d]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
};

/**
 * Quantos bytes do início toleramos antes da assinatura.
 *
 * Exigir a assinatura no byte zero recusaria arquivo legítimo: PDF remontado por alguns sistemas
 * processuais traz lixo antes do cabeçalho, e é justamente o público deste produto que sobe esse arquivo.
 * O `unpdf` tolera, então nós toleramos — dentro de uma janela curta.
 */
const JANELA_DA_ASSINATURA = 1024;

/**
 * ⚠️ O tipo do arquivo passa a ser LIDO, não acreditado.
 *
 * ── O defeito ─────────────────────────────────────────────────────────────────
 * A validação usava `file.type`, que é o Content-Type escrito na parte do formulário — escolhido por quem
 * envia. Qualquer arquivo (vídeo, executável, conteúdo ilícito) entrava no bucket pago do produto bastando
 * declarar `application/pdf`.
 *
 * O bucket é privado e o download força `attachment` com `nosniff`, então isto não era sequestro do site.
 * O dano é outro, e é jurídico: o fornecedor passa a ser depositário de conteúdo arbitrário de terceiro,
 * pagando o armazenamento, sem meio técnico de saber que aquilo não é um processo — e sem poder afirmar
 * que filtrava. Há também o efeito cotidiano: quem sobe arquivo corrompido ou renomeado recebe "documento
 * recebido", é cobrado, e só descobre depois que a análise saiu vazia.
 *
 * Devolve `null` quando confere, ou a mensagem de recusa.
 */
export function conferirAssinatura(mime: string, bytes: Buffer): string | null {
  const esperadas = ASSINATURAS[mime];
  /** Formato sem assinatura catalogada não é bloqueado aqui — `validateUpload` já decidiu o que entra. */
  if (!esperadas) return null;

  const inicio = bytes.subarray(0, JANELA_DA_ASSINATURA);
  const encontrou = esperadas.some((assinatura) => inicio.indexOf(Buffer.from(assinatura)) !== -1);
  if (encontrou) return null;

  const rotulo = ROTULO_MIME[mime] ?? mime;
  return `O arquivo não é um ${rotulo} de verdade: o conteúdo não corresponde ao formato declarado.`;
}

export async function extractText(data: Buffer, mime: string): Promise<ExtractionResult> {
  if (mime === "application/pdf") {
    return extractPdf(data);
  }
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return {
      pageCount: 0,
      pages: [],
      ocrApplied: false,
      paginasComTexto: 0,
      note: "Extração de DOCX pendente (instalar 'mammoth').",
    };
  }
  if (mime.startsWith("image/")) {
    return {
      pageCount: 1,
      pages: [{ page: 1, text: "", legible: false }],
      ocrApplied: false,
      paginasComTexto: 0,
      note: "OCR de imagem pendente (instalar Tesseract/serviço de OCR). Documento marcado como ilegível.",
    };
  }
  return { pageCount: 0, pages: [], ocrApplied: false, paginasComTexto: 0, note: `Tipo ${mime} não processado.` };
}

/**
 * Extração via `unpdf` (pdf.js atual). A biblioteca anterior (`pdf-parse`, que
 * embute um pdf.js de 2018) só lia PDF 1.4: a partir do 1.5, com object streams
 * e xref streams, falhava com "Invalid PDF structure" — justamente o formato
 * que PJe, eSAJ e Projudi produzem. Ver tests/documents.test.ts.
 *
 * Ganho adicional: o pdf.js devolve o texto POR PÁGINA, então `sourcePage` na
 * linha do tempo passa a apontar a página real do documento.
 */
async function extractPdf(data: Buffer): Promise<ExtractionResult> {
  try {
    const { getDocumentProxy, extractText: extrair } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(data));

    /**
     * ⚠️ Confere o TAMANHO antes de percorrer o documento.
     *
     * `getDocumentProxy` só lê a estrutura do PDF; é `extrair` que percorre página por página, e é ele que
     * prende o processo. Ler `numPages` primeiro custa nada e é a diferença entre recusar um documento
     * absurdo e ficar sem servidor. Ver `env.upload.maxPaginas` para o porquê do número.
     */
    const paginasDeclaradas = Number(doc.numPages) || 0;
    if (paginasDeclaradas > env.upload.maxPaginas) {
      return {
        pageCount: paginasDeclaradas,
        pages: [{ page: 1, text: "", legible: false }],
        ocrApplied: false,
        paginasComTexto: 0,
        note:
          `Documento com ${paginasDeclaradas} páginas excede o limite de ${env.upload.maxPaginas} ` +
          `páginas por arquivo. Divida a cópia do processo em partes e envie separadamente.`,
      };
    }

    const { totalPages, text } = await extrair(doc, { mergePages: false });

    const brutas = Array.isArray(text) ? text : [text];
    const pages: ExtractedPage[] = brutas.map((t, i) => {
      const limpo = (t ?? "").trim();
      // Legível = tem conteúdo, não apenas o carimbo do sistema processual.
      return { page: i + 1, text: limpo, legible: limpo.length >= MIN_CHARS_PAGINA };
    });

    const paginasComTexto = pages.filter((p) => p.legible).length;
    const total = totalPages || pages.length;
    const resultado: ExtractionResult = {
      pageCount: total,
      pages: pages.length ? pages : [{ page: 1, text: "", legible: false }],
      ocrApplied: false,
      paginasComTexto,
    };

    let diagnostico = diagnosticarLeitura(resultado);

    // PDF digitalizado: tenta transcrever por OCR antes de desistir. Sem isto o
    // sistema lê só o carimbo de cabeçalho e pode concluir pela ausência de
    // atos — parcelamento, penhora — que estão nas páginas em imagem.
    if (diagnostico === "digitalizado" && (await ocrDisponivel())) {
      // try próprio: uma falha aqui não pode cair no catch externo e descartar
      // as páginas nativas já extraídas.
      /**
       * O total vai como parâmetro: era daqui que o Ghostscript com `-dNOSAFER` tirava esse número.
       * Ver o comentário em `ocrPdf` — a função que o contava foi apagada, não corrigida.
       */
      const ocr = await ocrPdf(data, total).catch(() => null);
      if (ocr && ocr.paginasLidas > 0) {
        const porPagina = new Map(ocr.paginas.map((p) => [p.page, p.text]));
        // O OCR complementa: onde já havia camada de texto, ela prevalece.
        const mescladas: ExtractedPage[] = [];
        const ultima = Math.max(total, ...porPagina.keys());
        for (let n = 1; n <= ultima; n++) {
          const nativo = pages[n - 1]?.text ?? "";
          const texto = nativo.length >= MIN_CHARS_PAGINA ? nativo : (porPagina.get(n) ?? nativo);
          mescladas.push({ page: n, text: texto, legible: texto.length >= MIN_CHARS_PAGINA });
        }
        resultado.pages = mescladas;
        resultado.paginasComTexto = mescladas.filter((p) => p.legible).length;
        resultado.ocrApplied = true;
        diagnostico = diagnosticarLeitura(resultado);
        resultado.note =
          `OCR aplicado: ${resultado.paginasComTexto} de ${total} páginas legíveis ` +
          `(${paginasComTexto} tinham texto no arquivo, o restante foi transcrito).` +
          (ocr.truncado ? ` As páginas além da ${ocr.paginasLidas} não foram transcritas.` : "");
        if (diagnostico !== "digitalizado") return resultado;
      }
    }

    if (diagnostico === "digitalizado") {
      resultado.note =
        `PDF digitalizado: apenas ${paginasComTexto} de ${total} páginas têm texto legível. ` +
        `As demais são imagem e exigem OCR.`;
    } else if (diagnostico === "parcial") {
      resultado.note =
        `Leitura parcial: ${paginasComTexto} de ${total} páginas têm texto. ` +
        `As páginas digitalizadas não foram consideradas na análise.`;
    }
    return resultado;
  } catch (err) {
    return {
      pageCount: 0,
      pages: [{ page: 1, text: "", legible: false }],
      ocrApplied: false,
      paginasComTexto: 0,
      note: `Falha ao extrair PDF: ${(err as Error).message}`,
    };
  }
}
