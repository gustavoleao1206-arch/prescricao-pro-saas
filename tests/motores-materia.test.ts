import { describe, it, expect } from "vitest";
import { instrucoesDaMateria } from "../src/lib/ai/prompts-materia";
import { MOTOR_INTERCORRENTE } from "../src/lib/ai/motores/intercorrente";
import { MOTOR_ORDINARIA } from "../src/lib/ai/motores/ordinaria";
import { MOTOR_DECADENCIA } from "../src/lib/ai/motores/decadencia";
import { montarChecklist, DOCUMENTOS_POR_MATERIA } from "../src/lib/legal/checklist-documentos";
import { sanearResultado } from "../src/lib/ai/analise-dirigida";
import { MATERIAS, type MateriaSlug } from "../src/lib/ai/materias";

/**
 * Motores especializados de análise: um por matéria.
 *
 * Nesta versão pública os textos dos motores são exemplos (a metodologia real é
 * proprietária), então os testes verificam a ESTRUTURA: cada matéria tem o
 * próprio motor, com os próprios documentos prioritários e a mensagem padrão de
 * documento ausente, e o prompt final usa o motor certo — nunca um prompt único.
 */

const MOTORES: Record<MateriaSlug, string> = {
  prescricao_intercorrente: MOTOR_INTERCORRENTE,
  prescricao_ordinaria: MOTOR_ORDINARIA,
  decadencia_tributaria: MOTOR_DECADENCIA,
};

const MENSAGEM_AUSENTE: Record<MateriaSlug, string> = {
  prescricao_intercorrente: "Documento importante não localizado para análise da prescrição intercorrente.",
  prescricao_ordinaria: "Documento importante não localizado para análise da prescrição ordinária.",
  decadencia_tributaria: "Documento importante não localizado para análise da decadência.",
};

describe("estrutura de cada motor", () => {
  for (const m of MATERIAS) {
    describe(m.slug, () => {
      const motor = MOTORES[m.slug];

      it("abre com a matéria selecionada", () => {
        expect(motor.startsWith(`MATÉRIA SELECIONADA: ${m.label.toUpperCase()}`)).toBe(true);
      });

      it("lista os documentos prioritários da própria matéria", () => {
        for (const d of DOCUMENTOS_POR_MATERIA[m.slug]) {
          expect(motor, d.rotulo).toContain(d.rotulo);
        }
      });

      it("traz a mensagem padrão de documento ausente e o campo de destino", () => {
        expect(motor).toContain(MENSAGEM_AUSENTE[m.slug]);
        expect(motor).toContain("`documentosAusentes`");
      });

      it("pede o cálculo no campo `calculoPrazo`", () => {
        expect(motor).toContain("`calculoPrazo`");
      });
    });
  }
});

describe("montagem do prompt final", () => {
  it("cada matéria usa o seu motor, não um prompt único", () => {
    for (const m of MATERIAS) {
      const prompt = instrucoesDaMateria(m.slug);
      expect(prompt.startsWith(MOTORES[m.slug])).toBe(true);
      for (const outra of MATERIAS.filter((x) => x.slug !== m.slug)) {
        expect(prompt, `${m.slug} não pode conter o motor de ${outra.slug}`).not.toContain(MOTORES[outra.slug]);
      }
    }
  });

  it("os documentos de uma matéria não vazam para as outras", () => {
    // INFOJUD só existe na lista da intercorrente; Auto de Infração, só na da decadência.
    expect(instrucoesDaMateria("prescricao_intercorrente")).toContain("INFOJUD");
    expect(instrucoesDaMateria("prescricao_ordinaria")).not.toContain("INFOJUD");
    expect(instrucoesDaMateria("decadencia_tributaria")).not.toContain("INFOJUD");
    expect(instrucoesDaMateria("decadencia_tributaria")).toMatch(/Auto de Infração/);
    expect(instrucoesDaMateria("prescricao_intercorrente")).not.toMatch(/Auto de Infração/);
  });

  it("o checklist prévio entra no prompt quando fornecido", () => {
    const checklist = montarChecklist("prescricao_intercorrente", "CDA. Cite-se.");
    const prompt = instrucoesDaMateria("prescricao_intercorrente", checklist);
    expect(prompt).toMatch(/DETECÇÃO PRÉVIA DE DOCUMENTOS/);
    expect(prompt).toMatch(/✓ CDA/);
    expect(prompt).toMatch(/✗ /);
    // Sem checklist, o bloco não aparece.
    expect(instrucoesDaMateria("prescricao_intercorrente")).not.toMatch(/DETECÇÃO PRÉVIA/);
  });

  it("o esquema JSON exige a justificativa de confiança e a estratégia", () => {
    const p = instrucoesDaMateria("prescricao_ordinaria");
    expect(p).toContain('"justificativaConfianca"');
    expect(p).toContain('"estrategiaRecomendada"');
  });
});

describe("saneamento dos novos blocos obrigatórios", () => {
  const base = { tipoAnalise: "prescricao_intercorrente", resultado: "negativo" };

  it("sem justificativa da IA, compõe uma factual a partir dos documentos", () => {
    const a = sanearResultado(
      { ...base, grauConsistencia: "moderada", documentosUtilizados: ["CDA", "inicial"], documentosAusentes: ["AR"] },
      "prescricao_intercorrente",
    );
    expect(a.justificativaConfianca).toMatch(/2 utilizados/);
    expect(a.justificativaConfianca).toMatch(/1 ausente/);
  });

  it("estratégia existe em QUALQUER resultado, inclusive negativo", () => {
    // A trava esvazia peça e medida no resultado negativo; a estratégia fica,
    // porque orientação prática existe mesmo quando a tese não se sustenta.
    const a = sanearResultado({ ...base, peticao: "# peça indevida" }, "prescricao_intercorrente");
    expect(a.peticao).toBe("");
    expect(a.medidaProcessualSugerida).toBe("");
    expect(a.estrategiaRecomendada.length).toBeGreaterThan(10);
  });

  it("estratégia da IA é preservada e limpa de expressões absolutas", () => {
    // O positivo precisa sobreviver à trava temporal: marco documentado e
    // consumação no passado.
    const a = sanearResultado(
      {
        ...base,
        resultado: "positivo",
        estrategiaRecomendada: "Protocolar: causa ganha.",
        calculoPrazo: { marcoInicial: "01/01/2015", dataProvavelConsumacao: "01/01/2021", marcoFinal: "01/01/2021" },
      },
      "prescricao_intercorrente",
      new Date(Date.UTC(2026, 6, 22, 12)),
    );
    expect(a.resultado).toBe("positivo");
    expect(a.estrategiaRecomendada).not.toMatch(/causa ganha/);
    expect(a.estrategiaRecomendada).toMatch(/tese com elementos favoráveis/);
  });
});
