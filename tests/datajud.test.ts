import { describe, it, expect } from "vitest";
import {
  validarNumeroCNJ,
  normalizarNumero,
  formatarNumero,
  resolverIndice,
  DataJudError,
} from "../src/lib/pje/datajud";

/**
 * Cobre a camada offline do cliente DataJud — validação, formatação e
 * roteamento de tribunal. São as partes que decidem se a requisição chega a
 * sair, e todas rodam sem rede.
 *
 * A consulta em si não é testada aqui: depende da API do CNJ estar no ar, o
 * que tornaria a suíte instável. Ver `scripts/verificar-datajud.ts` para o
 * teste de integração manual.
 */

/** Número fictício no formato do TRF5 (dígito verificador válido), usado como âncora de formato. */
const PROCESSO_TRF5 = "99999997220264058400";

describe("validarNumeroCNJ", () => {
  it("aceita número com dígito verificador correto", () => {
    expect(validarNumeroCNJ(PROCESSO_TRF5)).toBe(true);
  });

  it("aceita número mascarado", () => {
    expect(validarNumeroCNJ("9999999-72.2026.4.05.8400")).toBe(true);
  });

  it("rejeita dígito verificador trocado", () => {
    // Mesmo processo com o DD alterado de 72 para 73.
    expect(validarNumeroCNJ("99999997320264058400")).toBe(false);
  });

  it("rejeita número com menos de 20 dígitos", () => {
    expect(validarNumeroCNJ("123456789")).toBe(false);
  });

  it("rejeita string vazia", () => {
    expect(validarNumeroCNJ("")).toBe(false);
  });
});

describe("normalizarNumero e formatarNumero", () => {
  it("remove a máscara", () => {
    expect(normalizarNumero("9999999-72.2026.4.05.8400")).toBe(PROCESSO_TRF5);
  });

  it("aplica a máscara no padrão CNJ", () => {
    expect(formatarNumero(PROCESSO_TRF5)).toBe("9999999-72.2026.4.05.8400");
  });

  it("devolve a entrada intacta quando não tem 20 dígitos", () => {
    expect(formatarNumero("123")).toBe("123");
  });

  it("é idempotente entre ida e volta", () => {
    expect(normalizarNumero(formatarNumero(PROCESSO_TRF5))).toBe(PROCESSO_TRF5);
  });
});

describe("resolverIndice", () => {
  it("roteia Justiça Federal pela região", () => {
    expect(resolverIndice(PROCESSO_TRF5)).toBe("api_publica_trf5");
  });

  it("roteia Justiça Estadual pela UF", () => {
    // J=8, TR=26 → São Paulo, onde corre a maior parte das execuções fiscais.
    expect(resolverIndice("00000000020248260000")).toBe("api_publica_tjsp");
  });

  it("roteia outra UF estadual", () => {
    // J=8, TR=19 → Rio de Janeiro.
    expect(resolverIndice("00000000020248190000")).toBe("api_publica_tjrj");
  });

  it("recusa segmento fora de execução fiscal", () => {
    // J=5 → Justiça do Trabalho.
    expect(() => resolverIndice("00000000020245010000")).toThrow(DataJudError);
  });

  it("recusa região federal inexistente", () => {
    // J=4, TR=09 → não existe TRF9.
    expect(() => resolverIndice("00000000020244090000")).toThrow(/Região federal/);
  });
});
