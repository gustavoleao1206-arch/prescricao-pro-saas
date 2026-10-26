import { describe, it, expect } from "vitest";
import { instrucoesDaPeca } from "../src/lib/ai/prompts-peca";
import { instrucoesDaMateria } from "../src/lib/ai/prompts-materia";
import { MATERIAS } from "../src/lib/ai/materias";

/**
 * Instruções de redação da peça.
 *
 * Nesta versão pública o texto das instruções é um exemplo (a metodologia real é
 * proprietária), então os testes verificam a ESTRUTURA: o bloco da peça existe
 * para toda matéria, traz a tabela cronológica com a página de cada ato, pedidos
 * próprios da matéria e marcadores no lugar de dado ausente, e chega ao prompt
 * final junto com a trava da petição.
 */

describe("estrutura do bloco da peça", () => {
  for (const m of MATERIAS) {
    it(`${m.slug}: cabeçalho, tabela cronológica e pedidos`, () => {
      const p = instrucoesDaPeca(m.slug);
      expect(p.startsWith("=== REDAÇÃO DA PEÇA (campo `peticao`) ===")).toBe(true);
      expect(p).toMatch(/\|\s*Data\s*\|\s*Evento\s*\|\s*Fls\.\s*\|\s*Efeito jurídico\s*\|/);
      expect(p).toMatch(/campo `pagina`/);
      expect(p).toMatch(/^PEDIDOS:/m);
    });
  }

  it("cada matéria pede o que lhe cabe, e não o das outras", () => {
    const pedidos = (m: Parameters<typeof instrucoesDaPeca>[0]) =>
      instrucoesDaPeca(m)
        .split("\n")
        .find((l) => l.startsWith("PEDIDOS:")) ?? "";
    expect(pedidos("prescricao_intercorrente")).toMatch(/intercorrente/i);
    expect(pedidos("prescricao_ordinaria")).toMatch(/ordinária/i);
    expect(pedidos("decadencia_tributaria")).toMatch(/decadência/i);
    expect(pedidos("prescricao_ordinaria")).not.toMatch(/intercorrente|decadência/i);
    expect(pedidos("decadencia_tributaria")).not.toMatch(/intercorrente|ordinária/i);
    expect(pedidos("prescricao_intercorrente")).not.toMatch(/ordinária|decadência/i);
  });

  it("dado ausente vira marcador entre colchetes, nunca exemplo inventado", () => {
    const p = instrucoesDaPeca("prescricao_intercorrente");
    expect(p).toMatch(/\[[A-ZÀ-Ú ]+\]/);
    expect(p).toMatch(/Não invente dados/);
  });
});

describe("integração com o prompt da matéria", () => {
  it("as instruções da peça chegam junto das da matéria", () => {
    for (const m of MATERIAS) {
      expect(instrucoesDaMateria(m.slug), `matéria ${m.slug}`).toContain(instrucoesDaPeca(m.slug));
    }
  });

  it("a trava da petição continua explícita no prompt", () => {
    const completo = instrucoesDaMateria("prescricao_intercorrente");
    expect(completo).toMatch(/SOMENTE quando `resultado` = "positivo"/);
  });
});
