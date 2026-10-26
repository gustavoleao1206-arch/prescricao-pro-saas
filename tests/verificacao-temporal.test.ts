import { describe, it, expect } from "vitest";
import {
  extrairData,
  somarAnos,
  formatarBR,
  verificarCoerenciaTemporal,
  memoriaDeCalculo,
} from "../src/lib/legal/verificacao-temporal";
import {
  sanearResultado,
  rotuloConclusao,
  geraPeticao,
  contradizDatasNegativo,
  temCausaObstativaAposMarco,
  rebaixarNegativoContraditorio,
  marcosAlternativosVencidos,
  inconclusivoComContagemVencida,
} from "../src/lib/ai/analise-dirigida";
import { montarChecklist } from "../src/lib/legal/checklist-documentos";
import { MOTOR_INTERCORRENTE } from "../src/lib/ai/motores/intercorrente";
import { instrucoesDaMateria } from "../src/lib/ai/prompts-materia";

/**
 * Trava temporal da conclusão — os 9 testes obrigatórios da especificação.
 *
 * MOTIVO (caso real): num processo de IPTU o sistema
 * respondeu "SIM, prescrição consumada" tendo calculado a consumação para
 * 22/06/2029 — três anos no futuro. A coerência entre resposta e datas é
 * aritmética e mora no servidor; estes testes garantem que nunca mais dependa
 * da IA.
 */

// Data da análise fixada como na especificação.
const HOJE = new Date(Date.UTC(2026, 6, 22, 12)); // 22/07/2026

/** Resposta mínima da IA para os cenários. */
function respostaIA(extra: Record<string, unknown>) {
  return {
    tipoAnalise: "prescricao_intercorrente",
    grauConsistencia: "alta",
    conclusao: "Texto da IA.",
    calculoPrazo: {},
    ...extra,
  };
}

describe("parser de datas dos documentos e da IA", () => {
  it("lê DD/MM/AAAA, ISO, com pontos e por extenso", () => {
    expect(formatarBR(extrairData("03/07/2029")!)).toBe("03/07/2029");
    expect(formatarBR(extrairData("2029-07-03")!)).toBe("03/07/2029");
    expect(formatarBR(extrairData("22.06.2023")!)).toBe("22/06/2023");
    expect(formatarBR(extrairData("22 de junho de 2023")!)).toBe("22/06/2023");
    expect(formatarBR(extrairData("ciência em 03/07/2023, conforme certidão da p. 18")!)).toBe("03/07/2023");
  });

  it("não chuta: texto sem data ou com data impossível vira null", () => {
    expect(extrairData("Informação não localizada no documento analisado.")).toBeNull();
    expect(extrairData("")).toBeNull();
    expect(extrairData(null)).toBeNull();
    expect(extrairData("31/02/2024 é impossível")).toBeNull();
  });

  it("soma anos preservando o dia (e trata 29/02)", () => {
    expect(formatarBR(somarAnos(extrairData("03/07/2023")!, 1))).toBe("03/07/2024");
    expect(formatarBR(somarAnos(extrairData("03/07/2024")!, 5))).toBe("03/07/2029");
    expect(formatarBR(somarAnos(extrairData("29/02/2024")!, 1))).toBe("28/02/2025");
  });
});

describe("TESTE 1 — consumação no futuro nunca é prescrição consumada", () => {
  it("positivo com consumação 03/07/2029 vira negativo em 22/07/2026", () => {
    const r = verificarCoerenciaTemporal(
      { resultado: "positivo", marcoInicial: "03/07/2023", dataProvavelConsumacao: "03/07/2029", marcoFinal: "03/07/2029" },
      "prescricao_intercorrente",
      HOJE,
    );
    expect(r.resultadoFinal).toBe("negativo");
    expect(r.verificacao.corrigido).toBe(true);
    expect(r.verificacao.situacaoPrazo).toBe("em_andamento");
  });

  it("o caso real de IPTU (consumação 22/06/2029)", () => {
    const a = sanearResultado(
      respostaIA({
        resultado: "positivo",
        calculoPrazo: { marcoInicial: "22/06/2023", dataProvavelConsumacao: "22/06/2029", marcoFinal: "22/06/2029" },
        peticao: "# EPE indevida",
      }),
      "prescricao_intercorrente",
      HOJE,
    );
    expect(a.resultado).toBe("negativo");
    expect(rotuloConclusao(a.tipoAnalise, a.resultado)).toBe("NÃO — PRESCRIÇÃO INTERCORRENTE AINDA NÃO CONSUMADA.");
    expect(a.verificacaoTemporal.corrigido).toBe(true);
    expect(a.verificacaoTemporal.dataAnalise).toBe("2026-07-22");
  });
});

describe("TESTE 2 — consumação no passado mantém a conclusão", () => {
  it("positivo com consumação 03/07/2025 permanece positivo em 22/07/2026", () => {
    const r = verificarCoerenciaTemporal(
      { resultado: "positivo", marcoInicial: "03/07/2019", dataProvavelConsumacao: "03/07/2025", marcoFinal: "03/07/2025" },
      "prescricao_intercorrente",
      HOJE,
    );
    expect(r.resultadoFinal).toBe("positivo");
    expect(r.verificacao.corrigido).toBe(false);
    expect(r.verificacao.situacaoPrazo).toBe("consumado");
  });
});

describe("TESTE 3 — sem prova da ciência não há consumação", () => {
  it("positivo sem marco inicial documentado vira inconclusivo", () => {
    const a = sanearResultado(
      respostaIA({
        resultado: "positivo",
        calculoPrazo: {
          marcoInicial: "Informação não localizada no documento analisado.",
          dataProvavelConsumacao: "01/01/2020",
          marcoFinal: "01/01/2020",
        },
      }),
      "prescricao_intercorrente",
      HOJE,
    );
    expect(a.resultado).toBe("inconclusivo");
    expect(rotuloConclusao(a.tipoAnalise, a.resultado)).toBe("INCONCLUSIVA — NECESSIDADE DE DOCUMENTOS COMPLEMENTARES.");
    expect(a.estrategiaRecomendada).toBe("Obter documentos complementares antes da adoção de medida judicial.");
  });

  it("positivo sem data de consumação verificável vira inconclusivo", () => {
    const a = sanearResultado(
      respostaIA({ resultado: "positivo", calculoPrazo: { marcoInicial: "03/07/2023" } }),
      "prescricao_intercorrente",
      HOJE,
    );
    expect(a.resultado).toBe("inconclusivo");
    expect(a.peticao).toBe("");
  });
});

describe("TESTE 4 — carta de citação com AR conta como citação localizada", () => {
  it("checklist marca citação sem exigir mandado do oficial", () => {
    const texto = "Carta de citação postal expedida. Aviso de Recebimento AR assinado pelo destinatário.";
    const c = montarChecklist("prescricao_intercorrente", texto);
    const porId = new Map(c.itens.map((i) => [i.id, i.encontrado]));
    expect(porId.get("citacao")).toBe(true);
    expect(porId.get("ar")).toBe(true);
    // Não existe mais item separado de mandado cuja ausência vire falha.
    expect(c.itens.find((i) => i.id === "mandado-citacao")).toBeUndefined();
  });

  it("o motor lista a citação, em qualquer modalidade, entre os documentos prioritários", () => {
    expect(MOTOR_INTERCORRENTE).toContain("Citação (carta, mandado, eletrônica ou edital)");
  });
});

describe("TESTE 5 e 6 — pedido de SISBAJUD × bloqueio efetivo", () => {
  it("o motor lista as pesquisas SISBAJUD entre os documentos prioritários", () => {
    expect(MOTOR_INTERCORRENTE).toContain("Pesquisas SISBAJUD/BACENJUD");
  });
  it("o prompt distingue penhora e bloqueio na classificação dos eventos", () => {
    expect(instrucoesDaMateria("prescricao_intercorrente")).toMatch(/\| penhora \| bloqueio \|/);
  });
});

describe("TESTE 7 — contradição interna bloqueia e corrige", () => {
  it("a peça é bloqueada junto com a correção do resultado", () => {
    const a = sanearResultado(
      respostaIA({
        resultado: "positivo",
        calculoPrazo: { marcoInicial: "03/07/2023", dataProvavelConsumacao: "03/07/2029", marcoFinal: "03/07/2029" },
        peticao: "# EPE que não pode sair",
        medidaProcessualSugerida: "Exceção de Pré-Executividade",
        estrategiaRecomendada: "Protocolar imediatamente.",
      }),
      "prescricao_intercorrente",
      HOJE,
    );
    expect(a.resultado).toBe("negativo");
    expect(a.peticao).toBe("");
    expect(geraPeticao(a)).toBe(false);
    // A estratégia da IA (protocolar) morre com o resultado corrigido.
    expect(a.estrategiaRecomendada).toMatch(/Não recomendar, neste momento, exceção de pré-executividade/);
    // O registro da contradição fica visível nos riscos.
    expect(a.riscos.join(" ")).toMatch(/Contradição detectada e corrigida automaticamente/);
    // E a conclusão textual antiga não permanece afirmando consumação.
    expect(a.conclusao).toMatch(/ainda não pode ser afirmada como consumada/);
    expect(a.verificacaoTemporal.resultadoOriginalIA).toMatch(/consumada/);
  });
});

describe("TESTE 8 — processo incompleto não presume atos posteriores", () => {
  it("o prompt proíbe presumir o conteúdo de atos que não constam do arquivo", () => {
    // A regra vive no bloco comum de conclusão, que integra o prompt de toda matéria.
    const p = instrucoesDaMateria("prescricao_intercorrente");
    expect(p).toMatch(/NUNCA presuma o conteúdo de atos que não constam do arquivo/);
    expect(p).toMatch(/DOCUMENTOS POSTERIORES/);
  });
});

describe("TESTE 9 — marco anterior possível fica como hipótese", () => {
  it("o motor manda registrar o documento ausente em vez de presumi-lo", () => {
    expect(MOTOR_INTERCORRENTE).toMatch(/nunca presuma o conteúdo dos ausentes/);
    expect(MOTOR_INTERCORRENTE).toContain("`documentosAusentes`");
  });

  it("o motor pede o marco inicial e a consumação no cálculo", () => {
    expect(MOTOR_INTERCORRENTE).toMatch(/marco inicial/);
    expect(MOTOR_INTERCORRENTE).toContain("`calculoPrazo`");
  });
});

describe("memória de cálculo gerada pelo sistema", () => {
  it("monta a contagem da intercorrente: ciência + 1 ano + 5 anos", () => {
    const linhas = memoriaDeCalculo(
      { marcoInicial: "03/07/2023 (certidão de intimação automática, p. 18)", dataProvavelConsumacao: "03/07/2029", marcoFinal: "" },
      "prescricao_intercorrente",
      HOJE,
    );
    const texto = linhas.join("\n");
    expect(texto).toContain("Ciência da Fazenda (marco adotado): 03/07/2023");
    expect(texto).toContain("+ 1 ano de suspensão");
    expect(texto).toContain("03/07/2024");
    expect(texto).toContain("+ 5 anos");
    expect(texto).toContain("03/07/2029");
    expect(texto).toContain("Data da análise: 22/07/2026");
    expect(texto).toMatch(/o prazo ainda não foi completado/);
  });

  it("aponta divergência quando a conta do sistema difere da data da IA", () => {
    const linhas = memoriaDeCalculo(
      { marcoInicial: "03/07/2023", dataProvavelConsumacao: "01/01/2027", marcoFinal: "" },
      "prescricao_intercorrente",
      HOJE,
    );
    expect(linhas.join("\n")).toMatch(/difere da contagem/);
  });

  it("sem marco parseável, não inventa contagem", () => {
    expect(
      memoriaDeCalculo(
        { marcoInicial: "Informação não localizada no documento analisado.", dataProvavelConsumacao: "", marcoFinal: "" },
        "prescricao_intercorrente",
        HOJE,
      ),
    ).toEqual([]);
  });
});

describe("reclassificação: inconclusiva com marco documentado e consumação futura", () => {
  it("o caso real após o novo motor: marco 03/07/2023 e pendências viram NÃO CONSUMADA", () => {
    // A IA, corretamente conservadora, respondeu inconclusiva por faltarem os
    // resultados das pesquisas patrimoniais. Mas com marco DOCUMENTADO e a
    // contagem legal caindo no futuro, a classificação B da especificação
    // manda responder "ainda não consumada", mantendo as pendências como
    // hipótese registrada.
    const a = sanearResultado(
      respostaIA({
        resultado: "inconclusivo",
        conclusao: "Não é possível afirmar categoricamente; faltam os resultados das pesquisas patrimoniais.",
        calculoPrazo: {
          marcoInicial: "03/07/2023 (início da intimação automática)",
          dataProvavelConsumacao: "Informação não localizada no documento analisado.",
          marcoFinal: "",
        },
        pontosParaAvaliacao: ["Buscar os resultados das pesquisas patrimoniais anteriores."],
      }),
      "prescricao_intercorrente",
      HOJE,
    );
    expect(a.resultado).toBe("negativo");
    expect(rotuloConclusao(a.tipoAnalise, a.resultado)).toBe("NÃO — PRESCRIÇÃO INTERCORRENTE AINDA NÃO CONSUMADA.");
    expect(a.verificacaoTemporal.dataConsumacao).toBe("2029-07-03");
    expect(a.verificacaoTemporal.situacaoPrazo).toBe("em_andamento");
    expect(a.conclusao).toMatch(/marco inicial documentado/);
    expect(a.conclusao).toMatch(/ainda não está consumada/);
    // A leitura original da IA não se perde: vira ponto de avaliação.
    expect(a.pontosParaAvaliacao.join(" ")).toMatch(/Leitura original da análise/);
    // Minuta segue bloqueada e estratégia é a de prazo em andamento.
    expect(a.peticao).toBe("");
    expect(a.estrategiaRecomendada).toMatch(/Não recomendar, neste momento, exceção de pré-executividade/);
  });

  it("inconclusiva com marco cuja contagem JÁ passou permanece inconclusiva", () => {
    // Promover a "consumada" exigiria prova, não presunção: se a contagem do
    // marco documentado já venceu, a dúvida da IA continua de pé.
    const a = sanearResultado(
      respostaIA({
        resultado: "inconclusivo",
        calculoPrazo: { marcoInicial: "01/01/2015", dataProvavelConsumacao: "", marcoFinal: "" },
      }),
      "prescricao_intercorrente",
      HOJE,
    );
    expect(a.resultado).toBe("inconclusivo");
  });
});

describe("coerência inversa: NÃO com a conta vencida (regressão da execução de 2009)", () => {
  // O caso real: marco 23/05/2013, consumação calculada 23/05/2019, e a IA
  // respondeu "não consumada" alegando que o processo estaria "dentro do
  // período de suspensão" treze anos depois. Um NÃO assim nega ao cliente uma
  // tese que os autos sustentam.
  const negativoContraditorio = () =>
    sanearResultado(
      respostaIA({
        resultado: "negativo",
        conclusao: "O processo ainda está dentro do período de suspensão do art. 40.",
        calculoPrazo: { marcoInicial: "23/05/2013", dataProvavelConsumacao: "23/05/2019", marcoFinal: "23/05/2019" },
        linhaDoTempo: [
          { data: "23/05/2013", evento: "Ciência da Fazenda sobre ausência de bens", pagina: "40", classificacao: "ciencia-fazenda", efeitoJuridico: "marco do art. 40", relevancia: "alta", confianca: "alta" },
          { data: "10/08/2015", evento: "Petição da Fazenda pedindo vista", pagina: "55", classificacao: "mera-intimacao", efeitoJuridico: "sem efeito", relevancia: "baixa", confianca: "alta" },
        ],
      }),
      "prescricao_intercorrente",
      HOJE,
    );

  it("detecta a contradição quando não há ato obstativo após o marco", () => {
    const a = negativoContraditorio();
    expect(a.verificacaoTemporal.situacaoPrazo).toBe("consumado");
    expect(temCausaObstativaAposMarco(a)).toBe(false);
    expect(contradizDatasNegativo(a)).toBe(true);
  });

  it("NÃO acusa contradição quando existe ato obstativo posterior ao marco", () => {
    const a = sanearResultado(
      respostaIA({
        resultado: "negativo",
        calculoPrazo: { marcoInicial: "23/05/2013", dataProvavelConsumacao: "23/05/2019", marcoFinal: "" },
        linhaDoTempo: [
          { data: "10/03/2016", evento: "Adesão a parcelamento", pagina: "60", classificacao: "parcelamento", efeitoJuridico: "interrompe (art. 174, p.ú., IV)", relevancia: "alta", confianca: "alta" },
        ],
      }),
      "prescricao_intercorrente",
      HOJE,
    );
    // Parcelamento depois do marco explica o NÃO: nada a corrigir.
    expect(contradizDatasNegativo(a)).toBe(false);
  });

  it("o rebaixamento nunca promove a consumada: vira inconclusivo com a contradição em vermelho", () => {
    const rebaixada = rebaixarNegativoContraditorio(negativoContraditorio());
    expect(rebaixada.resultado).toBe("inconclusivo");
    expect(rebaixada.grauConsistencia).toBe("baixa");
    expect(rebaixada.verificacaoTemporal.corrigido).toBe(true);
    expect(rebaixada.riscos.join(" ")).toMatch(/Contradição não resolvida/);
    expect(rebaixada.conclusao).toMatch(/data já vencida/);
    expect(geraPeticao(rebaixada)).toBe(false);
  });

  it("o prompt define os três resultados possíveis", () => {
    const p = instrucoesDaMateria("prescricao_intercorrente");
    expect(p).toMatch(/`resultado` = "positivo"/);
    expect(p).toMatch(/"negativo"/);
    expect(p).toMatch(/"inconclusivo"/);
  });

  it("a ordinária leva os documentos da própria matéria", () => {
    const p = instrucoesDaMateria("prescricao_ordinaria");
    expect(p).toContain("Extrato da dívida ativa");
    expect(p).toContain("Confissão de dívida");
  });

  it("a intercorrente leva os documentos da própria matéria", () => {
    const p = instrucoesDaMateria("prescricao_intercorrente");
    expect(p).toContain("Decisão de suspensão (art. 40 da LEF)");
    expect(p).toContain("Intimação ou ciência da Fazenda sobre a suspensão");
  });
});

describe("hesitação com a conta vencida (espelho da regra simétrica)", () => {
  it("inconclusivo com marco 13/12/2018 e sem obstativo configura o confronto", () => {
    // O caso real da 6ª rodada do IPTU: a IA adotou o marco certo, calculou
    // certo por dentro, e mesmo assim hesitou por falta das pesquisas
    // patrimoniais — cuja inexistência é o fundamento da tese, não lacuna.
    const a = sanearResultado(
      respostaIA({
        resultado: "inconclusivo",
        calculoPrazo: { marcoInicial: "13/12/2018 (início da intimação não atendida, p.12)", dataProvavelConsumacao: "", marcoFinal: "" },
        linhaDoTempo: [
          { data: "30/08/2017", evento: "Citação", pagina: "7", classificacao: "citacao", efeitoJuridico: "", relevancia: "alta", confianca: "alta" },
        ],
      }),
      "prescricao_intercorrente",
      HOJE,
    );
    // Citação de 2017 é ANTERIOR ao marco: não é obstativo posterior.
    expect(inconclusivoComContagemVencida(a, HOJE)).toBe("13/12/2024");
  });

  it("não configura quando a contagem do marco ainda não venceu", () => {
    const a = sanearResultado(
      respostaIA({
        resultado: "inconclusivo",
        calculoPrazo: { marcoInicial: "03/07/2023", dataProvavelConsumacao: "", marcoFinal: "" },
      }),
      "prescricao_intercorrente",
      HOJE,
    );
    // 03/07/2023 + 6 = 03/07/2029, futuro: hesitar aqui é legítimo…
    // (a reclassificação B do saneamento já transforma este caso em negativo.)
    expect(inconclusivoComContagemVencida(a, HOJE)).toBeNull();
  });

  it("não configura quando há obstativo posterior ao marco", () => {
    const a = sanearResultado(
      respostaIA({
        resultado: "inconclusivo",
        calculoPrazo: { marcoInicial: "13/12/2018", dataProvavelConsumacao: "", marcoFinal: "" },
        linhaDoTempo: [
          { data: "05/05/2020", evento: "Parcelamento deferido", pagina: "19", classificacao: "parcelamento", efeitoJuridico: "", relevancia: "alta", confianca: "alta" },
        ],
      }),
      "prescricao_intercorrente",
      HOJE,
    );
    expect(inconclusivoComContagemVencida(a, HOJE)).toBeNull();
  });
});

describe("marco alternativo vencido (IPTU municipal)", () => {
  // A IA adotou a decisão formal de 2023 como marco e respondeu "não
  // consumada", ignorando a intimação de 17/12/2018 com inércia certificada e
  // nenhuma diligência posterior. O detector expõe o marco ignorado para o
  // confronto do servidor com o modelo.
  const analiseIptu = () =>
    sanearResultado(
      respostaIA({
        resultado: "negativo",
        calculoPrazo: { marcoInicial: "03/07/2023", dataProvavelConsumacao: "03/07/2029", marcoFinal: "" },
        linhaDoTempo: [
          { data: "25/10/2017", evento: "Citação postal com AR positivo", pagina: "9", classificacao: "citacao", efeitoJuridico: "", relevancia: "alta", confianca: "alta" },
          { data: "17/12/2018", evento: "Intimação da Fazenda para prosseguimento, não atendida", pagina: "12", classificacao: "intimacao-fazenda", efeitoJuridico: "", relevancia: "alta", confianca: "alta" },
          { data: "20/05/2021", evento: "Certidão de decurso de prazo sem manifestação", pagina: "13", classificacao: "inercia", efeitoJuridico: "", relevancia: "alta", confianca: "alta" },
          { data: "22/06/2023", evento: "Decisão de suspensão art. 40", pagina: "16", classificacao: "suspensao", efeitoJuridico: "", relevancia: "alta", confianca: "alta" },
        ],
      }),
      "prescricao_intercorrente",
      HOJE,
    );

  it("detecta a intimação de 2018 como marco vencido (17/12/2018 + 6 anos = 17/12/2024)", () => {
    const marcos = marcosAlternativosVencidos(analiseIptu(), HOJE);
    expect(marcos.length).toBeGreaterThan(0);
    expect(marcos[0]!.data).toBe("17/12/2018");
    expect(marcos[0]!.consumacaoCalculada).toBe("17/12/2024");
    // A certidão de 2021 também venceria (2021+6=2027 > 2026? não: 20/05/2027
    // é futuro), então só a de 2018 conta.
    expect(marcos.every((m) => m.data !== "20/05/2021")).toBe(true);
  });

  it("a citação de 2017 NÃO entra como marco (citação é obstativo, não marco)", () => {
    const marcos = marcosAlternativosVencidos(analiseIptu(), HOJE);
    expect(marcos.every((m) => m.data !== "25/10/2017")).toBe(true);
  });

  it("ato obstativo posterior ao candidato o elimina", () => {
    const a = sanearResultado(
      respostaIA({
        resultado: "negativo",
        calculoPrazo: { marcoInicial: "03/07/2023", dataProvavelConsumacao: "03/07/2029", marcoFinal: "" },
        linhaDoTempo: [
          { data: "17/12/2018", evento: "Intimação não atendida", pagina: "12", classificacao: "intimacao-fazenda", efeitoJuridico: "", relevancia: "alta", confianca: "alta" },
          { data: "10/02/2020", evento: "Penhora de imóvel efetivada", pagina: "18", classificacao: "penhora", efeitoJuridico: "", relevancia: "alta", confianca: "alta" },
        ],
      }),
      "prescricao_intercorrente",
      HOJE,
    );
    // A penhora de 2020 obstou a contagem do candidato de 2018.
    expect(marcosAlternativosVencidos(a, HOJE)).toEqual([]);
  });

  it("sem marco anterior vencido, não há nada a confrontar", () => {
    const a = sanearResultado(
      respostaIA({
        resultado: "negativo",
        calculoPrazo: { marcoInicial: "03/07/2023", dataProvavelConsumacao: "03/07/2029", marcoFinal: "" },
        linhaDoTempo: [
          { data: "01/03/2022", evento: "Intimação recente", pagina: "20", classificacao: "intimacao-fazenda", efeitoJuridico: "", relevancia: "media", confianca: "alta" },
        ],
      }),
      "prescricao_intercorrente",
      HOJE,
    );
    // 2022 + 6 anos = 2028, ainda futuro: nada vencido a apontar.
    expect(marcosAlternativosVencidos(a, HOJE)).toEqual([]);
  });
});

describe("negativo com data passada não vira consumada por conta própria", () => {
  it("registra a divergência para revisão humana, sem promover o resultado", () => {
    // Conservador de propósito: pode haver interrupção que a IA considerou e a
    // aritmética simples não enxerga. Promover a consumada automaticamente
    // seria criar o erro inverso ao que se corrige.
    const r = verificarCoerenciaTemporal(
      { resultado: "negativo", marcoInicial: "01/01/2015", dataProvavelConsumacao: "01/01/2021", marcoFinal: "" },
      "prescricao_intercorrente",
      HOJE,
    );
    expect(r.resultadoFinal).toBe("negativo");
    expect(r.verificacao.corrigido).toBe(false);
    expect(r.verificacao.inconsistencias.join(" ")).toMatch(/já passou/);
  });
});
