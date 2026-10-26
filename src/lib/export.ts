/**
 * Exportação de relatórios/peças em DOCX (editável) e PDF (leitura/impressão),
 * a partir do conteúdo em Markdown. Executa no servidor (runtime Node).
 */

export async function markdownToDocx(title: string, markdown: string): Promise<Buffer> {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");

  const children: InstanceType<typeof Paragraph>[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) {
      children.push(new Paragraph({ text: "" }));
      continue;
    }
    if (line.startsWith("# ")) {
      children.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }));
    } else if (line.startsWith("## ")) {
      children.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
    } else if (line.startsWith("### ")) {
      children.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }));
    } else if (line.startsWith("> ")) {
      children.push(new Paragraph({ children: [new TextRun({ text: line.slice(2), italics: true, color: "555555" })] }));
    } else if (line.startsWith("- ")) {
      children.push(new Paragraph({ text: stripMd(line.slice(2)), bullet: { level: 0 } }));
    } else if (line.startsWith("|")) {
      // Linha de tabela — renderiza como texto simples (evita dependência de layout).
      children.push(new Paragraph({ children: [new TextRun({ text: line.replace(/\|/g, "  "), size: 18 })] }));
    } else {
      children.push(new Paragraph({ children: [new TextRun({ text: stripMd(line) })] }));
    }
  }

  const doc = new Document({
    creator: "Prescrição Pro",
    title,
    sections: [{ children }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

export async function markdownToPdf(title: string, markdown: string): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const marginX = 50;
  const marginY = 50;
  const pageSize: [number, number] = [595.28, 841.89]; // A4
  const maxWidth = pageSize[0] - marginX * 2;

  let page = pdf.addPage(pageSize);
  let y = pageSize[1] - marginY;

  const drawLine = (text: string, size: number, useBold: boolean) => {
    const f = useBold ? bold : font;
    for (const wrapped of wrapText(text, f, size, maxWidth)) {
      if (y < marginY + size) {
        page = pdf.addPage(pageSize);
        y = pageSize[1] - marginY;
      }
      page.drawText(wrapped, { x: marginX, y, size, font: f, color: rgb(0.1, 0.12, 0.2) });
      y -= size + 4;
    }
  };

  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) { y -= 8; continue; }
    if (line.startsWith("# ")) drawLine(line.slice(2), 18, true);
    else if (line.startsWith("## ")) drawLine(line.slice(3), 14, true);
    else if (line.startsWith("### ")) drawLine(line.slice(4), 12, true);
    else if (line.startsWith("- ")) drawLine("•  " + stripMd(line.slice(2)), 10, false);
    else drawLine(stripMd(line.replace(/^> /, "")), 10, false);
  }

  return Buffer.from(await pdf.save());
}

function stripMd(text: string): string {
  return text.replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1").replace(/`/g, "");
}

function wrapText(text: string, font: { widthOfTextAtSize: (t: string, s: number) => number }, size: number, maxWidth: number): string[] {
  // pdf-lib WinAnsi não suporta alguns caracteres; normaliza os mais comuns.
  const clean = text.replace(/[–—]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/⚖️|⚠️|✓|👋|◆|◈|★/g, "");
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}
