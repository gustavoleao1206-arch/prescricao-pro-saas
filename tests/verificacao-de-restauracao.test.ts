import { describe, it, expect } from "vitest";
import { encryptField } from "../src/lib/crypto";
import { classificarDocumentos } from "../scripts/verificar-restauracao";

/**
 * A classificação dos documentos guardados, dentro da verificação de restauração.
 *
 * ── Por que este arquivo existe ───────────────────────────────────────────────
 * Esta lógica reportou ERRADO duas vezes seguidas contra o banco de PRODUÇÃO, em 02/09/2026:
 *
 *  1. contou como "não abre com a chave" um documento que estava gravado EM CLARO — culpando a chave por
 *     um problema que não era dela, e anunciando perda de dado onde não havia nenhuma;
 *  2. depois de separar os casos na contagem, manteve uma explicação de dois ramos: quando o caso era
 *     "formato inesperado", o relatório dizia uma coisa na contagem e outra no texto.
 *
 * Relatório de verificação que mente é pior do que não ter relatório: ele gasta a confiança de quem lê
 * justamente no momento em que ela é necessária. Conferir à mão não bastou — e testar pelo banco também
 * não bastaria, porque o banco de teste tem documentos de outros arquivos e do seed, e a contagem nunca
 * fecharia. Por isso a classificação é PURA e os cinco estados são medidos aqui, um a um.
 */

const CPF = "52998224725";
const CPF_COM_PONTUACAO = "529.982.247-25";
const CNPJ = "11222333000181";

const linha = (documentEnc: string) => [{ id: "linha-1", documentEnc }];

describe("os cinco estados de um documento guardado", () => {
  it("cifrado e legível: aprovado, sem aviso", () => {
    const r = classificarDocumentos(linha(encryptField(CPF)));

    expect(r.ok).toBe(true);
    expect(r.aviso).toBeFalsy();
    expect(r.detalhe).toMatch(/legíveis/);
  });

  it("⚠️ CPF com PONTUAÇÃO é aprovado — foi este o caso que apareceu em produção", () => {
    /**
     * `529.982.247-25` é dado perfeitamente legível: a chave abriu. A versão anterior o acusava, e o
     * relatório sugeria perda de dado que não existia.
     */
    const r = classificarDocumentos(linha(encryptField(CPF_COM_PONTUACAO)));

    expect(r.ok).toBe(true);
    expect(r.detalhe).not.toMatch(/EM CLARO|NÃO ABRE/);
  });

  it("CNPJ de 14 dígitos também é aprovado", () => {
    const r = classificarDocumentos(linha(encryptField(CNPJ)));

    expect(r.ok).toBe(true);
    expect(r.aviso).toBeFalsy();
  });

  it("⚠️ CNPJ com pontuação é aprovado — e é ESTE caso que prova a limpeza", () => {
    /**
     * O caso do CPF pontuado acima passa por COINCIDÊNCIA: `529.982.247-25` tem exatamente 14
     * caracteres, o mesmo tamanho de um CNPJ sem pontuação, então ele é aprovado mesmo sem remover a
     * pontuação. Descobri isso desligando a limpeza de propósito e vendo o teste continuar verde.
     *
     * `11.222.333/0001-81` tem 18 caracteres. Só passa se a pontuação for realmente removida antes de
     * contar — é a única forma de este teste medir o que diz medir.
     */
    const r = classificarDocumentos(linha(encryptField("11.222.333/0001-81")));

    expect(r.ok).toBe(true);
    expect(r.aviso).toBeFalsy();
    expect(r.detalhe).toMatch(/legíveis/);
  });

  it("⚠️ gravado EM CLARO: reprovado, dizendo que NÃO há perda", () => {
    const r = classificarDocumentos(linha(CPF));

    expect(r.ok).toBe(false);
    expect(r.detalhe).toMatch(/EM CLARO/);
    expect(r.detalhe).toMatch(/INTACTO/);
    /** Não pode culpar a chave: ela não tem nada a ver com este caso. */
    expect(r.detalhe).not.toMatch(/NÃO ABRE/);
    expect(r.detalhe).not.toMatch(/irrecuperável/);
  });

  it("⚠️ cifrado que NÃO ABRE: reprovado, apontando a chave e a perda", () => {
    const cifrado = encryptField(CPF);
    const r = classificarDocumentos(linha(cifrado.slice(0, -8) + "AAAAAAAA"));

    expect(r.ok).toBe(false);
    expect(r.detalhe).toMatch(/NÃO ABRE/);
    expect(r.detalhe).toMatch(/FIELD_ENCRYPTION_KEY/);
    expect(r.detalhe).toMatch(/irrecuperável/);
    /** E não pode dizer que o dado está intacto: aqui há perda de verdade. */
    expect(r.detalhe).not.toMatch(/INTACTO/);
  });

  it("abre com conteúdo que não é documento: AVISO, não reprovação", () => {
    /** A chave abriu, então ela está certa. Formato estranho é qualidade de dado. */
    const r = classificarDocumentos(linha(encryptField("nao-e-um-documento")));

    expect(r.ok).toBe(true);
    expect(r.aviso).toBe(true);
    expect(r.detalhe).toMatch(/chave está correta/);
  });

  it("sem documento nenhum: aprovado, mas avisando que nada foi provado", () => {
    const r = classificarDocumentos([]);

    expect(r.ok).toBe(true);
    expect(r.aviso).toBe(true);
  });
});

describe("⚠️ a gravidade é decidida pelo PIOR estado presente", () => {
  it("um que não abre, no meio de vários bons, reprova e fala da chave", () => {
    const cifrado = encryptField(CPF);
    const r = classificarDocumentos([
      { id: "bom-1", documentEnc: encryptField(CPF) },
      { id: "bom-2", documentEnc: encryptField(CNPJ) },
      { id: "ruim", documentEnc: cifrado.slice(0, -8) + "AAAAAAAA" },
    ]);

    expect(r.ok).toBe(false);
    expect(r.detalhe).toMatch(/NÃO ABRE/);
    expect(r.detalhe).toContain("ruim");
    expect(r.detalhe).toMatch(/de 3:/);
  });

  it("com um em claro E um que não abre, o que não abre é o que aparece", () => {
    /** A perda irreversível manda no relatório: é a informação que muda o que a pessoa faz agora. */
    const cifrado = encryptField(CPF);
    const r = classificarDocumentos([
      { id: "claro", documentEnc: CPF },
      { id: "ruim", documentEnc: cifrado.slice(0, -8) + "AAAAAAAA" },
    ]);

    expect(r.detalhe).toMatch(/NÃO ABRE/);
    expect(r.detalhe).not.toMatch(/EM CLARO/);
  });
});

describe("⚠️ o relatório NUNCA imprime o documento", () => {
  it("nenhum estado devolve o valor do CPF na mensagem", () => {
    /**
     * O detalhe vai para a tela e pode ir para log. Um verificador que imprime CPF para diagnosticar
     * cifragem seria um vazamento nascido dentro da própria ferramenta de segurança.
     */
    for (const estado of [encryptField(CPF), CPF, encryptField(CPF_COM_PONTUACAO), CPF_COM_PONTUACAO]) {
      const r = classificarDocumentos(linha(estado));
      expect(r.detalhe).not.toContain(CPF);
      expect(r.detalhe).not.toContain(CPF_COM_PONTUACAO);
      expect(r.detalhe).not.toContain("529");
    }
  });
});
