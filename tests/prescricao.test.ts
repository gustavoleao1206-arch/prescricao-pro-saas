import { describe, it, expect } from "vitest";
import {
  addYears,
  parseData,
  analisarDecadencia,
  analisarPrescricaoOrdinaria,
  analisarPrescricaoIntercorrente,
} from "../src/lib/legal/prescricao";

describe("utilitários de data", () => {
  it("addYears preserva o dia", () => {
    expect(addYears(new Date(2010, 0, 15), 5).getFullYear()).toBe(2015);
  });
  it("parseData aceita ISO e BR", () => {
    expect(parseData("2010-01-15")?.getFullYear()).toBe(2010);
    expect(parseData("15/01/2010")?.getMonth()).toBe(0);
    expect(parseData("data inválida")).toBeNull();
    expect(parseData(null)).toBeNull();
  });
});

describe("decadência (CTN art. 173 I / 150 §4º)", () => {
  it("regra geral: 5 anos do 1º dia do exercício seguinte", () => {
    const r = analisarDecadencia({ dataFatoGerador: "2010-05-10", hoje: new Date(2020, 0, 1) });
    expect(r.prazoFinal?.getFullYear()).toBe(2016); // início 2011-01-01 + 5
    expect(r.ocorrido).toBe(true);
  });
  it("homologação com pagamento antecipado: 5 anos do fato gerador", () => {
    const r = analisarDecadencia({
      modalidade: "homologacao",
      houvePagamentoAntecipado: true,
      dataFatoGerador: "2010-05-10",
      hoje: new Date(2014, 0, 1),
    });
    expect(r.prazoFinal?.getFullYear()).toBe(2015);
    expect(r.ocorrido).toBe(false);
  });
  it("sem fato gerador => indeterminado", () => {
    const r = analisarDecadencia({});
    expect(r.confianca).toBe("INDETERMINADO");
    expect(r.ocorrido).toBeNull();
    expect(r.faltando.length).toBeGreaterThan(0);
  });
});

describe("prescrição ordinária (CTN art. 174)", () => {
  it("consumada quando o despacho ocorre após 5 anos da constituição", () => {
    const r = analisarPrescricaoOrdinaria({
      dataConstituicaoDefinitiva: "2010-01-15",
      dataDespachoCitatorio: "2016-02-01",
      hoje: new Date(2017, 0, 1),
    });
    expect(r.prazoFinal?.getFullYear()).toBe(2015);
    expect(r.ocorrido).toBe(true);
  });
  it("não consumada quando o despacho ocorre dentro do prazo", () => {
    const r = analisarPrescricaoOrdinaria({
      dataConstituicaoDefinitiva: "2010-01-15",
      dataDespachoCitatorio: "2013-01-01",
      hoje: new Date(2013, 6, 1),
    });
    expect(r.ocorrido).toBe(false);
  });
  it("sem constituição definitiva => indeterminado", () => {
    const r = analisarPrescricaoOrdinaria({});
    expect(r.confianca).toBe("INDETERMINADO");
    expect(r.ocorrido).toBeNull();
  });
});

describe("prescrição intercorrente (LEF art. 40 / Súmula 314 / Tema 566)", () => {
  it("consuma após 1 ano de suspensão + 5 anos de arquivamento", () => {
    const r = analisarPrescricaoIntercorrente({
      dataDespachoSuspensao: "2012-06-20",
      hoje: new Date(2019, 0, 1),
    });
    expect(r.prazoFinal?.getFullYear()).toBe(2018); // 2012 +1 +5
    expect(r.ocorrido).toBe(true);
  });
  it("indício de interrupção efetiva torna o resultado indeterminado", () => {
    const r = analisarPrescricaoIntercorrente({
      dataDespachoSuspensao: "2012-06-20",
      houveCausaInterrupcaoAposArquivamento: true,
      hoje: new Date(2019, 0, 1),
    });
    expect(r.ocorrido).toBeNull();
  });
  it("sem marco inicial => indeterminado", () => {
    const r = analisarPrescricaoIntercorrente({});
    expect(r.confianca).toBe("INDETERMINADO");
  });
});
