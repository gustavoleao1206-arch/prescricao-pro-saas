import { describe, it, expect, beforeAll } from "vitest";
import { extractText, diagnosticarLeitura } from "../src/lib/documents";
import { PDFDocument, StandardFonts } from "pdf-lib";

/**
 * Regressão do extrator de PDF.
 *
 * MOTIVO: a biblioteca original (`pdf-parse`, pdf.js de 2018) lia apenas
 * PDF 1.4. Em PDF 1.5+ — que usa object streams e cross-reference streams, o
 * formato dos sistemas processuais brasileiros (PJe, eSAJ, Projudi) — falhava
 * com "Invalid PDF structure", devolvendo o documento como ilegível.
 *
 * Estes testes travam esse comportamento: se alguém trocar o extrator por um
 * que não aguente PDF moderno, a suíte quebra aqui e não em produção.
 */

const TEXTO = "Processo no 0801234-56.2015.8.02.0001 citado em 22/04/2013";

/**
 * Página com volume de texto compatível com uma peça real. Uma linha só ficaria
 * abaixo do limiar de legibilidade e confundiria estes testes com os de
 * documento digitalizado.
 */
function escreverPagina(pdf: PDFDocument, font: Awaited<ReturnType<PDFDocument["embedFont"]>>) {
  const page = pdf.addPage([595, 842]);
  page.drawText(TEXTO, { x: 50, y: 780, size: 11, font });
  for (let l = 0; l < 10; l++) {
    page.drawText("Manifestacao da parte executada com fundamentacao e pedidos.", {
      x: 50, y: 750 - l * 16, size: 10, font,
    });
  }
}

/** PDF com xref/object streams (>= 1.5) — o caso que quebrava antes. */
async function pdfModerno(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  escreverPagina(pdf, await pdf.embedFont(StandardFonts.Helvetica));
  return Buffer.from(await pdf.save({ useObjectStreams: true }));
}

/** PDF com tabela xref clássica (1.4) — o único que a lib antiga lia. */
async function pdfClassico(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  escreverPagina(pdf, await pdf.embedFont(StandardFonts.Helvetica));
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

describe("extração de PDF", () => {
  let moderno: Buffer;
  let classico: Buffer;

  beforeAll(async () => {
    moderno = await pdfModerno();
    classico = await pdfClassico();
  });

  it("lê PDF com object streams (1.5+), formato dos tribunais", async () => {
    const r = await extractText(moderno, "application/pdf");
    expect(r.pages.some((p) => p.legible)).toBe(true);
    expect(r.pages.map((p) => p.text).join(" ")).toContain("0801234-56.2015.8.02.0001");
  });

  it("continua lendo PDF com xref clássica (1.4)", async () => {
    const r = await extractText(classico, "application/pdf");
    expect(r.pages.some((p) => p.legible)).toBe(true);
    expect(r.pages.map((p) => p.text).join(" ")).toContain("0801234-56.2015.8.02.0001");
  });

  it("separa o texto por página real do documento", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const marca of ["PAGINA UM", "PAGINA DOIS", "PAGINA TRES"]) {
      pdf.addPage([595, 842]).drawText(marca, { x: 50, y: 780, size: 11, font });
    }
    const r = await extractText(Buffer.from(await pdf.save()), "application/pdf");
    expect(r.pageCount).toBe(3);
    expect(r.pages).toHaveLength(3);
    expect(r.pages[0]?.text).toContain("PAGINA UM");
    expect(r.pages[2]?.text).toContain("PAGINA TRES");
  });

  it("marca como ilegível o PDF sem camada de texto, sem lançar erro", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]); // página em branco = digitalização sem OCR
    const r = await extractText(Buffer.from(await pdf.save()), "application/pdf");
    expect(r.pages.some((p) => p.legible)).toBe(false);
    expect(r.note).toMatch(/digitalizado/i);
  });

  it("degrada com aviso quando o arquivo não é um PDF válido", async () => {
    const r = await extractText(Buffer.from("isto nao e um pdf"), "application/pdf");
    expect(r.pages.some((p) => p.legible)).toBe(false);
    expect(r.note).toBeTruthy();
  });
});

/**
 * Regressão do caso real que motivou esta checagem: um processo de 166 páginas
 * digitalizado, em que TODA página trazia o carimbo do sistema ("1/2", número
 * de folha). O extrator via texto, dava o documento por legível e a análise
 * saía vazia — sem datas, sem linha do tempo — sem avisar o cliente.
 */
describe("diagnóstico de PDF digitalizado", () => {
  /** Monta um PDF com `total` páginas, das quais `comTexto` têm conteúdo real. */
  async function pdfMisto(total: number, comTexto: number): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < total; i++) {
      const page = pdf.addPage([595, 842]);
      // Carimbo presente em todas as páginas, como nos sistemas processuais.
      page.drawText(`${i + 1}/${total}`, { x: 500, y: 810, size: 8, font });
      if (i < comTexto) {
        for (let l = 0; l < 12; l++) {
          page.drawText("Conteudo processual relevante com texto suficiente nesta linha.", {
            x: 50, y: 760 - l * 16, size: 10, font,
          });
        }
      }
    }
    return Buffer.from(await pdf.save());
  }

  it("página com apenas o carimbo do sistema não conta como legível", async () => {
    const r = await extractText(await pdfMisto(5, 0), "application/pdf");
    expect(r.paginasComTexto).toBe(0);
    expect(diagnosticarLeitura(r)).toBe("digitalizado");
    expect(r.note).toMatch(/digitalizado/i);
  });

  it("reproduz o caso real: poucas páginas com texto em muitas digitalizadas", async () => {
    // Proporção do documento que falhou: 12 de 166 páginas (7%).
    const r = await extractText(await pdfMisto(30, 2), "application/pdf");
    expect(r.paginasComTexto).toBe(2);
    expect(diagnosticarLeitura(r)).toBe("digitalizado");
    expect(r.note).toContain("2 de 30");
  });

  it("documento com metade das páginas legíveis é leitura parcial, não bloqueio", async () => {
    const r = await extractText(await pdfMisto(10, 4), "application/pdf");
    expect(diagnosticarLeitura(r)).toBe("parcial");
    expect(r.note).toMatch(/parcial/i);
  });

  it("documento com texto na maioria das páginas é legível e sem aviso", async () => {
    const r = await extractText(await pdfMisto(10, 9), "application/pdf");
    expect(diagnosticarLeitura(r)).toBe("legivel");
    expect(r.note).toBeUndefined();
  });

  /**
   * Regressão do limiar de legibilidade. Ele estava em 200 caracteres e
   * descartava página curta mas real — um despacho "Cite-se. Maceió,
   * 05/03/2011" tem ~40 caracteres. Medição no processo digitalizado real
   * mostrou distribuição bimodal (carimbo com mediana de 6 caracteres,
   * conteúdo acima de 200): entre 25 e 200 o resultado era idêntico, então o
   * limiar alto não comprava precisão e cobrava leitura.
   */
  it("lê página curta mas com conteúdo real, como um despacho de uma linha", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 4; i++) {
      pdf.addPage([595, 842]).drawText(
        "DESPACHO: Cite-se o executado na forma da lei. Maceio, 05/03/2011.",
        { x: 40, y: 760, size: 11, font },
      );
    }
    const r = await extractText(Buffer.from(await pdf.save()), "application/pdf");
    expect(r.paginasComTexto).toBe(4);
    expect(diagnosticarLeitura(r)).toBe("legivel");
  });

  it("ainda descarta página que só tem o carimbo do sistema processual", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 6; i++) {
      pdf.addPage([595, 842]).drawText(`${i}/6`, { x: 520, y: 810, size: 8, font });
    }
    const r = await extractText(Buffer.from(await pdf.save()), "application/pdf");
    expect(r.paginasComTexto).toBe(0);
    expect(diagnosticarLeitura(r)).toBe("digitalizado");
  });
});
