import { describe, it, expect } from "vitest";
import { apenasDigitos, validarCPF, validarCNPJ, validarCpfCnpj, formatarCpfCnpj } from "../src/lib/documento";

/**
 * Validação de CPF/CNPJ.
 *
 * O boleto exige o documento na criação do cliente no Asaas. Errar aqui tem dois
 * custos: aceitar um documento inválido joga o cliente contra um erro cru do
 * provedor no meio da compra, e recusar um válido impede a venda de alguém que
 * digitou certo. Os dois são falhas de conversão, então vale trancar as duas
 * direções.
 *
 * Os documentos usados são conhecidamente válidos pelos dígitos verificadores e
 * não pertencem a ninguém em particular — a conta é aritmética, não cadastral.
 */

describe("CPF", () => {
  it("aceita CPF válido, com e sem máscara", () => {
    expect(validarCPF("529.982.247-25")).toBe(true);
    expect(validarCPF("52998224725")).toBe(true);
  });

  it("recusa dígito verificador errado", () => {
    // Último dígito trocado de 5 para 6.
    expect(validarCPF("52998224726")).toBe(false);
  });

  it("recusa todos os dígitos iguais", () => {
    /**
     * `111.111.111-11` PASSA na conta dos verificadores mas não existe. É a
     * armadilha clássica de quem valida só a aritmética — e o caso mais comum de
     * gente testando formulário.
     */
    for (const repetido of ["00000000000", "11111111111", "99999999999"]) {
      expect(validarCPF(repetido), repetido).toBe(false);
    }
  });

  it("recusa comprimento errado", () => {
    expect(validarCPF("5299822472")).toBe(false);
    expect(validarCPF("529982247255")).toBe(false);
    expect(validarCPF("")).toBe(false);
  });
});

describe("CNPJ", () => {
  it("aceita CNPJ válido, com e sem máscara", () => {
    expect(validarCNPJ("11.222.333/0001-81")).toBe(true);
    expect(validarCNPJ("11222333000181")).toBe(true);
  });

  it("recusa dígito verificador errado", () => {
    expect(validarCNPJ("11222333000182")).toBe(false);
  });

  it("recusa todos os dígitos iguais", () => {
    expect(validarCNPJ("00000000000000")).toBe(false);
    expect(validarCNPJ("11111111111111")).toBe(false);
  });

  it("recusa comprimento errado", () => {
    expect(validarCNPJ("1122233300018")).toBe(false);
  });
});

describe("validação combinada", () => {
  it("identifica o tipo e devolve só os dígitos", () => {
    expect(validarCpfCnpj("529.982.247-25")).toEqual({ digitos: "52998224725", tipo: "CPF" });
    expect(validarCpfCnpj("11.222.333/0001-81")).toEqual({ digitos: "11222333000181", tipo: "CNPJ" });
  });

  it("devolve nulo para documento inválido ou de tamanho estranho", () => {
    expect(validarCpfCnpj("52998224726")).toBeNull();
    expect(validarCpfCnpj("123")).toBeNull();
    expect(validarCpfCnpj("")).toBeNull();
    // 12 dígitos: nem CPF nem CNPJ.
    expect(validarCpfCnpj("123456789012")).toBeNull();
  });
});

describe("apresentação", () => {
  it("aplica a máscara conforme o tipo", () => {
    expect(formatarCpfCnpj("52998224725")).toBe("529.982.247-25");
    expect(formatarCpfCnpj("11222333000181")).toBe("11.222.333/0001-81");
  });

  it("devolve o valor original quando não reconhece o tamanho", () => {
    expect(formatarCpfCnpj("123")).toBe("123");
  });

  it("extrai dígitos de qualquer formatação", () => {
    expect(apenasDigitos(" 529.982.247-25 ")).toBe("52998224725");
  });
});
