import { describe, it, expect } from "vitest";
import { extrairDadosProcesso, tituloSugerido, brasileira } from "../src/lib/legal/extracao";

/**
 * Testes da leitura determinística da cópia do processo.
 *
 * A regra que orienta estes casos: é preferível NÃO extrair a extrair errado.
 * Um campo vazio o motor reporta como pendência; um campo errado contamina o
 * cálculo de prazo e pode induzir a uma peça equivocada.
 */

const PECA = `
PODER JUDICIÁRIO
TRIBUNAL DE JUSTIÇA DE ALAGOAS
COMARCA DE MACEIÓ
2ª VARA DE EXECUÇÕES FISCAIS

EXECUÇÃO FISCAL
Processo nº 0801234-56.2019.8.02.0001

EXEQUENTE: MUNICÍPIO DE MACEIÓ
EXECUTADO: COMERCIAL EXEMPLO LTDA    CNPJ 12.345.678/0001-90

Certidão de Dívida Ativa nº 2018/004512, referente a IPTU.

Fato gerador em 01/01/2014.
A constituição definitiva do crédito ocorreu em 15/03/2015.
Inscrição em dívida ativa em 20/07/2016.
Distribuído em 10/02/2019.
Em 05/03/2019 o Juízo determinou a citação do executado.
O executado foi citado em 22/04/2019, por oficial de justiça.
`;

describe("extração — identificação", () => {
  const d = extrairDadosProcesso(PECA);

  it("lê o número do processo no padrão CNJ", () => {
    expect(d.processNumber).toBe("0801234-56.2019.8.02.0001");
  });

  it("lê as partes", () => {
    expect(d.creditor).toBe("MUNICÍPIO DE MACEIÓ");
    expect(d.debtor).toBe("COMERCIAL EXEMPLO LTDA");
  });

  it("lê o CNPJ do executado", () => {
    expect(d.debtorDocument).toBe("12.345.678/0001-90");
  });

  it("lê comarca, vara e tribunal", () => {
    expect(d.jurisdiction).toBe("MACEIÓ");
    expect(d.courtDivision).toContain("VARA");
    expect(d.court).toContain("ALAGOAS");
  });

  it("lê a CDA e o tributo", () => {
    expect(d.cdaNumber).toBe("2018/004512");
    expect(d.taxType).toBe("IPTU");
  });
});

describe("extração — datas-marco", () => {
  const d = extrairDadosProcesso(PECA);

  it("associa cada data ao seu rótulo", () => {
    expect(d.facts.dataFatoGerador).toBe("2014-01-01");
    expect(d.facts.dataConstituicaoDefinitiva).toBe("2015-03-15");
    expect(d.facts.dataInscricaoDividaAtiva).toBe("2016-07-20");
    expect(d.facts.dataAjuizamento).toBe("2019-02-10");
    expect(d.facts.dataCitacao).toBe("2019-04-22");
  });

  it("lê data por extenso", () => {
    const d2 = extrairDadosProcesso("O executado foi citado em 3 de dezembro de 2020.");
    expect(d2.facts.dataCitacao).toBe("2020-12-03");
  });

  it("aceita rótulo sem acento", () => {
    const d2 = extrairDadosProcesso("Inscricao em divida ativa em 09/09/2017.");
    expect(d2.facts.dataInscricaoDividaAtiva).toBe("2017-09-09");
  });

  /**
   * Regressão de um erro real: com a data ANTES do rótulo ("Em 05/03/2013 o
   * Juízo determinou a citação"), a busca só para frente pulava para a data
   * seguinte — a da citação — e trocava o marco interruptivo do art. 174 CTN.
   */
  it("lê data escrita ANTES do rótulo, sem pegar a do evento seguinte", () => {
    const d = extrairDadosProcesso(PECA);
    expect(d.facts.dataDespachoCitatorio).toBe("2019-03-05");
    expect(d.facts.dataCitacao).toBe("2019-04-22");
    expect(d.facts.dataDespachoCitatorio).not.toBe(d.facts.dataCitacao);
  });

  it("lê rótulo e data em linhas separadas (capa de processo tabulada)", () => {
    const d = extrairDadosProcesso("Data da distribuicao:\n10/02/2013\nValor: R$ 4.200,00");
    expect(d.facts.dataAjuizamento).toBe("2013-02-10");
  });

  it("não atravessa fim de frase para trás", () => {
    const t = "Fato gerador em 01/01/2014. A constituicao definitiva ocorreu em 15/03/2015.";
    const d = extrairDadosProcesso(t);
    expect(d.facts.dataFatoGerador).toBe("2014-01-01");
    expect(d.facts.dataConstituicaoDefinitiva).toBe("2015-03-15");
  });

  it("não confunde despacho e citação quando as duas datas estão próximas", () => {
    const t = "Em 1º de fevereiro de 2018 foi determinada a citacao. O executado foi citado em 20/03/2018.";
    const d = extrairDadosProcesso(t);
    expect(d.facts.dataDespachoCitatorio).toBe("2018-02-01");
    expect(d.facts.dataCitacao).toBe("2018-03-20");
  });
});

describe("extração — recusa de dado duvidoso", () => {
  it("descarta data impossível", () => {
    const d = extrairDadosProcesso("Citado em 31/02/2019.");
    expect(d.facts.dataCitacao).toBeUndefined();
  });

  it("descarta ano fora de faixa plausível", () => {
    const d = extrairDadosProcesso("Citado em 10/05/1832.");
    expect(d.facts.dataCitacao).toBeUndefined();
  });

  it("não pega data distante do rótulo", () => {
    const longe = `Citação do executado.${" texto de permeio.".repeat(40)} 10/05/2019.`;
    expect(extrairDadosProcesso(longe).facts.dataCitacao).toBeUndefined();
  });

  it("não deduz penhora/parcelamento por menção no texto", () => {
    const d = extrairDadosProcesso("Nada impede a penhora e o parcelamento na forma da lei.");
    expect(d.facts.possuiPenhora).toBeUndefined();
    expect(d.facts.possuiParcelamento).toBeUndefined();
  });

  it("em documento vazio não inventa nada e reporta as pendências", () => {
    const d = extrairDadosProcesso("");
    expect(d.processNumber).toBeUndefined();
    expect(d.debtor).toBeUndefined();
    expect(Object.keys(d.facts)).toHaveLength(0);
    expect(d.ausentes.length).toBeGreaterThan(5);
    expect(d.encontrados).toHaveLength(0);
  });
});

describe("extração — apoio à exibição", () => {
  it("relata o que encontrou e o que falta", () => {
    const d = extrairDadosProcesso(PECA);
    expect(d.encontrados.some((e) => e.includes("0801234-56.2019.8.02.0001"))).toBe(true);
    expect(d.ausentes.some((a) => a.includes("confirmar nos autos"))).toBe(true);
  });

  it("sugere título a partir do processo, da parte ou do arquivo", () => {
    expect(tituloSugerido(extrairDadosProcesso(PECA), "x.pdf")).toBe("Execução fiscal 0801234-56.2019.8.02.0001");
    expect(tituloSugerido(extrairDadosProcesso("EXECUTADO: FULANO LTDA"), "x.pdf")).toBe("Execução fiscal — FULANO LTDA");
    expect(tituloSugerido(extrairDadosProcesso(""), "processo-joao.pdf")).toBe("Análise — processo-joao");
  });

  it("formata data para exibição", () => {
    expect(brasileira("2019-04-22")).toBe("22/04/2019");
  });
});
