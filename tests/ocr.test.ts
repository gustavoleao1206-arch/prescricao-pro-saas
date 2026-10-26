import { describe, it, expect, beforeAll } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * OCR de PDF digitalizado.
 *
 * MOTIVO: cópia integral de execução fiscal sai dos sistemas processuais como
 * imagem. No processo real que motivou esta funcionalidade, 144 de 166 páginas
 * eram digitalizadas — o sistema lia 13% do documento e recusava a análise,
 * incluindo as páginas que registravam parcelamento e o rito do art. 40.
 *
 * Depende de Ghostscript e Tesseract instalados. Onde faltarem, os testes que
 * exercitam a transcrição são pulados em vez de falhar: o recuo sem OCR já é
 * coberto em tests/documents.test.ts.
 */

const exec = promisify(execFile);

async function binariosPresentes(): Promise<boolean> {
  try {
    await exec("gs", ["--version"]);
    const { stdout } = await exec("tesseract", ["--list-langs"]);
    return stdout.split(/\r?\n/).some((l) => l.trim() === "por");
  } catch {
    return false;
  }
}

/** PDF cujo texto é desenhado grande, para o OCR ter chance de acertar. */
async function pdfComTexto(linhas: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  linhas.forEach((linha, i) => page.drawText(linha, { x: 40, y: 760 - i * 40, size: 22, font }));
  return Buffer.from(await pdf.save());
}

describe("OCR", () => {
  let disponivel = false;
  beforeAll(async () => {
    disponivel = await binariosPresentes();
  });

  it("detecta a disponibilidade dos binários sem lançar erro", async () => {
    process.env.OCR_ENABLED = "true";
    const { ocrDisponivel, resetOcrCache } = await import("../src/lib/ocr");
    resetOcrCache();
    await expect(ocrDisponivel()).resolves.toBeTypeOf("boolean");
  });

  /*
   * A chave OCR_ENABLED é lida na carga do módulo de configuração, não a cada
   * chamada — alterar process.env durante o teste não tem efeito. O que dá para
   * verificar aqui é que a checagem não explode; o desligamento em si é
   * exercitado pela própria suíte, que roda com OCR_ENABLED=false
   * (vitest.config.ts) e por isso nunca dispara OCR em extractText.
   */

  it("transcreve o texto de um PDF rasterizado", async () => {
    if (!disponivel) return; // sem Ghostscript/Tesseract: coberto pelo recuo sem OCR
    process.env.OCR_ENABLED = "true";
    const { ocrPdf, resetOcrCache } = await import("../src/lib/ocr");
    resetOcrCache();
    const pdf = await pdfComTexto(["SUSPENSAO DO FEITO", "ART 40 DA LEF", "ARQUIVAMENTO"]);
    /** O 1 é o TOTAL de páginas do documento (o PDF tem uma), não o teto — ver a assinatura de `ocrPdf`. */
    const r = await ocrPdf(pdf, 1);
    expect(r.paginasLidas).toBeGreaterThan(0);
    const texto = r.paginas.map((p) => p.text).join(" ").toUpperCase();
    // Não exige transcrição perfeita: o OCR erra caracteres. Basta reconhecer
    // os termos que orientam a seleção de páginas e a análise.
    expect(texto).toMatch(/ART|LEF|40/);
  }, 120_000);

  it("respeita o teto de páginas", async () => {
    if (!disponivel) return;
    process.env.OCR_ENABLED = "true";
    const { ocrPdf, resetOcrCache } = await import("../src/lib/ocr");
    resetOcrCache();
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 5; i++) {
      pdf.addPage([595, 842]).drawText(`PAGINA ${i + 1}`, { x: 40, y: 700, size: 28, font });
    }
    /**
     * ⚠️ A ORDEM DOS PARÂMETROS MUDOU, e este teste é o que garante que ninguém a confunda.
     *
     * O segundo parâmetro passou a ser o TOTAL de páginas do documento — antes era o teto. A troca veio de
     * apagar a função que contava páginas rodando Ghostscript com `-dNOSAFER` (ver `ocrPdf`). Passar 5 e 2
     * aqui exercita as duas coisas ao mesmo tempo: o total vem de fora, e o teto continua cortando.
     */
    const r = await ocrPdf(Buffer.from(await pdf.save()), 5, 2);
    expect(r.paginasNoDocumento).toBe(5);
    expect(r.truncado).toBe(true);
    expect(r.paginas.every((p) => p.page <= 2)).toBe(true);
  }, 120_000);

  it("não lança erro em arquivo que não é PDF", async () => {
    if (!disponivel) return;
    process.env.OCR_ENABLED = "true";
    const { ocrPdf, resetOcrCache } = await import("../src/lib/ocr");
    resetOcrCache();
    await expect(ocrPdf(Buffer.from("isto nao e um pdf"), 1)).resolves.toMatchObject({ paginasLidas: 0 });
  }, 60_000);

  it("total de páginas inválido devolve vazio sem chamar binário nenhum", async () => {
    const { ocrPdf } = await import("../src/lib/ocr");
    /** Quem chama passa o que o unpdf devolveu; PDF malformado pode dar 0 ou NaN. */
    for (const total of [0, -3, Number.NaN]) {
      await expect(ocrPdf(Buffer.from("%PDF-1.4"), total)).resolves.toMatchObject({ paginasLidas: 0 });
    }
  }, 60_000);
});
