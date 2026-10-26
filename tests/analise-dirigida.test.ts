import { describe, it, expect } from "vitest";
import {
  sanearResultado,
  geraPeticao,
  ROTULO_RESULTADO,
  NAO_LOCALIZADO,
} from "../src/lib/ai/analise-dirigida";
import { MATERIAS, isMateriaSlug, materiaPorSlug, materiaPorTipo } from "../src/lib/ai/materias";
import { instrucoesDaMateria, AVISO_LEGAL_ANALISE } from "../src/lib/ai/prompts-materia";

/**
 * Cobre os cenários obrigatórios da análise dirigida.
 *
 * O saneamento é a fronteira de confiança com a IA: ela é uma fonte externa e
 * pode devolver qualquer coisa. O caso mais sério é o Cenário 7 — petição
 * acompanhando resultado negativo —, porque entregaria ao cliente uma peça
 * sustentando tese que a própria análise negou.
 */

/** Resposta bem formada, como a IA deveria responder. */
function respostaIA(over: Record<string, unknown> = {}) {
  return {
    tipoAnalise: "prescricao_intercorrente",
    resultado: "positivo",
    grauConsistencia: "alta",
    conclusao: "Transcorreram mais de seis anos sem constrição efetiva.",
    resumoExecutivo: "Execução ajuizada em 2013, arquivada em 2015, sem penhora.",
    linhaDoTempo: [
      { data: "15/03/2018", evento: "Despacho suspendendo a execução", pagina: "148", efeitoJuridico: "Início da suspensão do art. 40 da LEF", relevancia: "alta" },
    ],
    calculoPrazo: {
      marcoInicial: "15/03/2015", prazoAplicavel: "1 ano de suspensão + 5 anos",
      periodosSuspensao: ["15/03/2015 a 15/03/2016"], atosInterruptivos: [],
      marcoFinal: "15/03/2021", dataProvavelConsumacao: "15/03/2021",
      explicacao: "Suspensão de um ano a partir da ciência, seguida do quinquênio.",
    },
    fundamentacaoLegal: ["Art. 40 da Lei nº 6.830/1980", "Art. 174 do CTN"],
    precedentes: ["Súmula 314/STJ", "Tema 566/STJ"],
    elementosFavoraveis: ["Ausência de penhora efetiva"],
    riscos: ["Eventual diligência não juntada aos autos"],
    documentosUtilizados: ["Página 148 do PDF"],
    documentosAusentes: ["Certidão de arquivamento"],
    pontosParaAvaliacao: [],
    medidaProcessualSugerida: "Exceção de Pré-Executividade",
    justificativaMedida: "Matéria de ordem pública, comprovável de plano.",
    peticao: "EXCELENTÍSSIMO SENHOR DOUTOR JUIZ...",
    ...over,
  };
}

describe("catálogo de matérias", () => {
  it("expõe exatamente as três matérias exigidas", () => {
    expect(MATERIAS.map((m) => m.label)).toEqual([
      "Prescrição Intercorrente",
      "Prescrição Ordinária",
      "Decadência Tributária",
    ]);
  });

  it("mapeia cada matéria para um tipo já existente no banco (sem migração)", () => {
    expect(MATERIAS.map((m) => m.tipo)).toEqual(["PRESCRICAO_INTERCORRENTE", "PRESCRICAO", "DECADENCIA"]);
  });

  it("faz o caminho de volta do tipo gravado para a matéria", () => {
    expect(materiaPorTipo("PRESCRICAO")?.slug).toBe("prescricao_ordinaria");
    expect(materiaPorTipo("DECADENCIA")?.slug).toBe("decadencia_tributaria");
    expect(materiaPorTipo("NULIDADES")).toBeNull();
  });

  it("rejeita slug desconhecido", () => {
    expect(isMateriaSlug("prescricao_intercorrente")).toBe(true);
    expect(isMateriaSlug("qualquer_coisa")).toBe(false);
    expect(isMateriaSlug(null)).toBe(false);
  });
});

describe("prompts por matéria", () => {
  it("cada matéria tem instruções próprias e o esquema JSON", () => {
    for (const m of MATERIAS) {
      const p = instrucoesDaMateria(m.slug);
      expect(p).toContain("MATÉRIA SELECIONADA");
      expect(p).toContain('"tipoAnalise"');
      expect(p).toContain("REGRAS INEGOCIÁVEIS CONTRA INVENÇÃO");
      expect(p).toContain("Informação não localizada no documento analisado.");
    }
  });

  it("cada matéria abre com o próprio motor e a própria mensagem de documento ausente", () => {
    const ausente: Record<string, string> = {
      prescricao_intercorrente: "prescrição intercorrente",
      prescricao_ordinaria: "prescrição ordinária",
      decadencia_tributaria: "decadência",
    };
    for (const m of MATERIAS) {
      const p = instrucoesDaMateria(m.slug);
      expect(p.startsWith(`MATÉRIA SELECIONADA: ${m.label.toUpperCase()}`)).toBe(true);
      expect(p).toContain(`Documento importante não localizado para análise da ${ausente[m.slug]}.`);
      for (const outra of MATERIAS.filter((x) => x.slug !== m.slug)) {
        expect(p).not.toContain(`MATÉRIA SELECIONADA: ${outra.label.toUpperCase()}`);
      }
    }
  });

  it("proíbe expressões absolutas", () => {
    const p = instrucoesDaMateria("prescricao_ordinaria");
    for (const e of ["causa ganha", "direito garantido", "prescrição garantida"]) {
      expect(p).toContain(e);
    }
  });
});

// ---------------------------------------------------------------------------
// Cenários obrigatórios
// ---------------------------------------------------------------------------

describe("Cenário 2 — intercorrente positiva: fundamentação e petição", () => {
  const r = sanearResultado(respostaIA(), "prescricao_intercorrente");

  it("mantém o resultado positivo e a petição", () => {
    expect(r.resultado).toBe("positivo");
    expect(r.peticao).not.toBe("");
    expect(geraPeticao(r)).toBe(true);
  });

  it("preserva fundamentação, precedentes e cálculo", () => {
    expect(r.fundamentacaoLegal).toContain("Art. 40 da Lei nº 6.830/1980");
    expect(r.precedentes).toContain("Tema 566/STJ");
    expect(r.calculoPrazo.marcoInicial).toBe("15/03/2015");
    expect(r.linhaDoTempo[0]?.pagina).toBe("148");
  });

  it("usa o rótulo destacado correto", () => {
    expect(ROTULO_RESULTADO[r.resultado]).toBe("SIM, FORAM IDENTIFICADOS ELEMENTOS FAVORÁVEIS");
  });
});

describe("Cenário 3 — intercorrente negativa: fundamentação sem petição", () => {
  const r = sanearResultado(
    respostaIA({
      resultado: "negativo",
      conclusao: "Houve penhora efetiva em 2017, que interrompeu a contagem.",
      peticao: "",
      pontosParaAvaliacao: ["Avaliar excesso de execução."],
    }),
    "prescricao_intercorrente",
  );

  it("não gera petição", () => {
    expect(r.peticao).toBe("");
    expect(geraPeticao(r)).toBe(false);
  });

  it("mantém fundamentação e pontos para avaliação", () => {
    expect(r.fundamentacaoLegal.length).toBeGreaterThan(0);
    expect(r.pontosParaAvaliacao).toContain("Avaliar excesso de execução.");
  });

  it("usa o rótulo negativo", () => {
    expect(ROTULO_RESULTADO[r.resultado]).toBe("NÃO FORAM IDENTIFICADOS ELEMENTOS SUFICIENTES");
  });
});

describe("Cenário 4 — ordinária positiva: contagem e petição", () => {
  const r = sanearResultado(
    respostaIA({
      tipoAnalise: "prescricao_ordinaria",
      resultado: "positivo",
      fundamentacaoLegal: ["Art. 174 do CTN", "LC nº 118/2005"],
      calculoPrazo: {
        marcoInicial: "10/05/2008", prazoAplicavel: "5 anos (art. 174 do CTN)",
        periodosSuspensao: [], atosInterruptivos: ["Despacho citatório em 12/2014 — posterior ao quinquênio"],
        marcoFinal: "10/05/2013", dataProvavelConsumacao: "10/05/2013",
        explicacao: "Constituição em 10/05/2008 + 5 anos = 10/05/2013; despacho só em 2014.",
      },
    }),
    "prescricao_ordinaria",
  );

  it("traz a contagem completa e a petição", () => {
    expect(r.tipoAnalise).toBe("prescricao_ordinaria");
    expect(r.calculoPrazo.explicacao).toContain("10/05/2013");
    expect(r.calculoPrazo.atosInterruptivos.length).toBe(1);
    expect(geraPeticao(r)).toBe(true);
  });
});

describe("Cenário 5 — decadência negativa: explica a regra, sem petição", () => {
  const r = sanearResultado(
    respostaIA({
      tipoAnalise: "decadencia_tributaria",
      resultado: "negativo",
      conclusao: "Houve pagamento antecipado; aplica-se o art. 150, §4º, e o lançamento foi tempestivo.",
      fundamentacaoLegal: ["Art. 150, §4º do CTN"],
      peticao: "",
      medidaProcessualSugerida: "",
    }),
    "decadencia_tributaria",
  );

  it("explica a regra aplicada e não gera petição", () => {
    expect(r.conclusao).toContain("art. 150, §4º");
    expect(r.fundamentacaoLegal).toContain("Art. 150, §4º do CTN");
    expect(r.peticao).toBe("");
    expect(geraPeticao(r)).toBe(false);
  });
});

describe("Cenário 6 — processo incompleto: inconclusivo sem petição", () => {
  const r = sanearResultado(
    respostaIA({
      resultado: "inconclusivo",
      documentosAusentes: ["Certidão de Dívida Ativa", "Despacho de citação", "Certidão de suspensão"],
      peticao: "",
    }),
    "prescricao_intercorrente",
  );

  it("lista os documentos ausentes e não gera petição", () => {
    expect(r.documentosAusentes).toContain("Certidão de Dívida Ativa");
    expect(r.peticao).toBe("");
    expect(geraPeticao(r)).toBe(false);
    expect(ROTULO_RESULTADO[r.resultado]).toBe("ANÁLISE INCONCLUSIVA: DOCUMENTAÇÃO INSUFICIENTE");
  });
});

describe("Cenário 7 — a IA manda petição com resultado negativo", () => {
  it("o backend remove a petição, mesmo a IA insistindo", () => {
    const r = sanearResultado(
      respostaIA({ resultado: "negativo", peticao: "EXCELENTÍSSIMO... peça indevida" }),
      "prescricao_intercorrente",
    );
    expect(r.resultado).toBe("negativo");
    expect(r.peticao).toBe("");
    expect(geraPeticao(r)).toBe(false);
  });

  it("também remove em resultado inconclusivo", () => {
    const r = sanearResultado(
      respostaIA({ resultado: "inconclusivo", peticao: "peça indevida" }),
      "prescricao_intercorrente",
    );
    expect(r.peticao).toBe("");
  });

  it("remove junto a medida sugerida, que só existe acompanhando a peça", () => {
    const r = sanearResultado(
      respostaIA({ resultado: "negativo", medidaProcessualSugerida: "Embargos", justificativaMedida: "x" }),
      "prescricao_intercorrente",
    );
    expect(r.medidaProcessualSugerida).toBe("");
    expect(r.justificativaMedida).toBe("");
  });
});

describe("saneamento — respostas malformadas da IA", () => {
  it("resultado fora do enum vira inconclusivo (o lado seguro)", () => {
    const r = sanearResultado(respostaIA({ resultado: "talvez" }), "prescricao_intercorrente");
    expect(r.resultado).toBe("inconclusivo");
    expect(r.peticao).toBe("");
  });

  it("grau inválido vira baixa", () => {
    expect(sanearResultado(respostaIA({ grauConsistencia: "altíssima" }), "prescricao_intercorrente").grauConsistencia).toBe("baixa");
  });

  it("a matéria da resposta não sobrepõe a escolhida pelo usuário", () => {
    const r = sanearResultado(respostaIA({ tipoAnalise: "decadencia_tributaria" }), "prescricao_intercorrente");
    expect(r.tipoAnalise).toBe("prescricao_intercorrente");
  });

  it("neutraliza expressões absolutas proibidas", () => {
    const r = sanearResultado(
      respostaIA({ conclusao: "A prescrição garantida assegura causa ganha ao executado." }),
      "prescricao_intercorrente",
    );
    expect(r.conclusao).not.toMatch(/prescri[çc][ãa]o garantida/i);
    expect(r.conclusao).not.toMatch(/causa ganha/i);
  });

  it("resposta vazia não quebra e não inventa conteúdo", () => {
    const r = sanearResultado({}, "prescricao_ordinaria");
    expect(r.resultado).toBe("inconclusivo");
    expect(r.linhaDoTempo).toEqual([]);
    expect(r.calculoPrazo.marcoInicial).toBe(NAO_LOCALIZADO);
    expect(r.peticao).toBe("");
  });

  it("resposta nula ou de tipo errado não quebra", () => {
    expect(sanearResultado(null, "decadencia_tributaria").resultado).toBe("inconclusivo");
    expect(sanearResultado("texto solto", "decadencia_tributaria").resultado).toBe("inconclusivo");
  });

  it("descarta evento sem descrição em vez de criar linha vazia", () => {
    const r = sanearResultado(
      respostaIA({ linhaDoTempo: [{ data: "01/01/2020", evento: "", pagina: "3" }, { data: "02/01/2020", evento: "Penhora", pagina: "4" }] }),
      "prescricao_intercorrente",
    );
    expect(r.linhaDoTempo).toHaveLength(1);
    expect(r.linhaDoTempo[0]?.evento).toBe("Penhora");
  });

  it("o aviso legal é sempre o texto oficial, não o que a IA escrever", () => {
    const r = sanearResultado(respostaIA({ avisoLegal: "texto adulterado" }), "prescricao_intercorrente");
    expect(r.avisoLegal).toBe(AVISO_LEGAL_ANALISE);
    expect(r.avisoLegal).toContain("caráter auxiliar");
    expect(r.avisoLegal).toContain("não garante o acolhimento da tese");
  });
});

describe("Cenário 8 — nova análise parte de estado limpo", () => {
  it("sanear duas respostas seguidas não deixa resíduo da anterior", () => {
    const primeira = sanearResultado(respostaIA(), "prescricao_intercorrente");
    const segunda = sanearResultado(
      { tipoAnalise: "decadencia_tributaria", resultado: "negativo", conclusao: "Sem decadência." },
      "decadencia_tributaria",
    );
    expect(primeira.peticao).not.toBe("");
    expect(segunda.peticao).toBe("");
    expect(segunda.linhaDoTempo).toEqual([]);
    expect(segunda.elementosFavoraveis).toEqual([]);
    expect(segunda.tipoAnalise).toBe("decadencia_tributaria");
  });
});

describe("materiaPorSlug", () => {
  it("devolve rótulo e resumo de cada matéria", () => {
    expect(materiaPorSlug("prescricao_intercorrente").label).toBe("Prescrição Intercorrente");
    expect(materiaPorSlug("decadencia_tributaria").resumo).toContain("173");
  });
});
