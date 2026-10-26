import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * O assistente de preenchimento manual só pode anunciar o que a Plataforma lê.
 *
 * ── O defeito ─────────────────────────────────────────────────────────────────
 * A tela dizia "PDF (preferencialmente pesquisável), DOCX ou imagens". DOCX era recusado no envio e
 * imagem era aceita e nunca lida — o cliente pagava e recebia análise vazia. Os textos legais publicados
 * (FAQ, Uso Aceitável) dizem que só o PDF tem o texto lido; a tela, dentro do produto pago, dizia outra
 * coisa. Oferta veiculada vincula o fornecedor (arts. 30 e 37 do CDC). Encontrado no levantamento de
 * prontidão para vendas de 03/09/2026.
 *
 * O `accept` no input é a metade técnica da correção: o seletor de arquivos do navegador já não oferece
 * outro formato. A frase é a metade jurídica.
 */

const semComentarios = (fonte: string) =>
  fonte.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const fonte = semComentarios(readFileSync("src/components/app/new-analysis-wizard.tsx", "utf8"));

describe("assistente manual: formatos anunciados", () => {
  it("⚠️ não promete DOCX nem imagem", () => {
    expect(fonte).not.toMatch(/DOCX/);
    expect(fonte).not.toMatch(/\bimagens?\b(?![^<]*OCR)/i);
  });

  it("diz que é somente PDF e explica o OCR do PDF digitalizado", () => {
    expect(fonte).toMatch(/Somente PDF/);
    expect(fonte).toMatch(/OCR/);
  });

  it("⚠️ o seletor de arquivos só aceita PDF", () => {
    /** Sem `accept`, o cliente escolhe uma imagem, envia, e só descobre no erro do servidor. */
    expect(fonte).toMatch(/<input[^>]*type="file"[^>]*accept="application\/pdf"/);
  });
});
