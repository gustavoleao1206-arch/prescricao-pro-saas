import { describe, it, expect } from "vitest";
import { CASOS_TESTE } from "../src/lib/legal/casos-teste";
import {
  analisarDecadencia,
  analisarPrescricaoOrdinaria,
  analisarPrescricaoIntercorrente,
  analisarPrescricaoRedirecionamento,
} from "../src/lib/legal/prescricao";

/**
 * Validação comparativa (gabarito) — exercita o motor jurídico determinístico
 * sobre os casos fictícios e confere o veredicto de cada instituto (incluindo o
 * redirecionamento) e o ano do prazo final da tese principal.
 * O gabarito fica em src/lib/legal/casos-teste.ts.
 */

type Verd = "SIM" | "NÃO" | "INDETERMINADO";
const toVerd = (ocorrido: boolean | null): Verd => (ocorrido === null ? "INDETERMINADO" : ocorrido ? "SIM" : "NÃO");

describe("Casos de teste comparativos (gabarito do motor jurídico)", () => {
  for (const caso of CASOS_TESTE) {
    describe(caso.titulo, () => {
      const hoje = new Date(caso.calc.hoje);

      const dec = analisarDecadencia({ ...caso.calc.decadencia, hoje });
      const ord = analisarPrescricaoOrdinaria({ ...caso.calc.ordinaria, hoje });
      const inter = analisarPrescricaoIntercorrente({ ...caso.calc.intercorrente, hoje });
      const redir = caso.calc.redirecionamento
        ? analisarPrescricaoRedirecionamento({ ...caso.calc.redirecionamento, hoje })
        : null;

      it("decadência bate com o gabarito", () => {
        expect(toVerd(dec.ocorrido)).toBe(caso.gabarito.decadencia);
      });
      it("prescrição ordinária bate com o gabarito", () => {
        expect(toVerd(ord.ocorrido)).toBe(caso.gabarito.ordinaria);
      });
      it("prescrição intercorrente bate com o gabarito", () => {
        expect(toVerd(inter.ocorrido)).toBe(caso.gabarito.intercorrente);
      });

      if (caso.gabarito.redirecionamento) {
        it("prescrição do redirecionamento bate com o gabarito", () => {
          expect(redir ? toVerd(redir.ocorrido) : "INDETERMINADO").toBe(caso.gabarito.redirecionamento);
        });
      }

      if (caso.gabarito.prazoFinalAnoTesePrincipal) {
        it("ano do prazo final da tese principal confere", () => {
          const tese = caso.gabarito.tesePrincipal;
          const alvo =
            tese === "Decadência"
              ? dec.prazoFinal
              : tese === "Prescrição intercorrente"
                ? inter.prazoFinal
                : tese === "Prescrição do redirecionamento"
                  ? redir?.prazoFinal
                  : ord.prazoFinal;
          expect(alvo?.getFullYear()).toBe(caso.gabarito.prazoFinalAnoTesePrincipal);
        });
      }
    });
  }

  it("os 4 casos estão definidos", () => {
    expect(CASOS_TESTE).toHaveLength(4);
  });
});
