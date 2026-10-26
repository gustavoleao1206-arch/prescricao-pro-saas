import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A chave que cifra CPF/CNPJ em repouso — e o que acontece quando ela falta.
 *
 * ── O defeito de origem (achado M-1 da auditoria de 16/08/2026) ───────────────
 * Sem `FIELD_ENCRYPTION_KEY`, `getKey()` derivava a chave do `AUTH_SECRET` em silêncio: sem erro, sem
 * log, sem olhar se era produção. Duas consequências, e a primeira é perda de dado sem volta:
 *
 *  1. Trocar o `AUTH_SECRET` — exatamente o que se faz depois de qualquer incidente de sessão — tornaria
 *     TODO CPF/CNPJ já gravado impossível de decifrar.
 *  2. Duas fechaduras com a mesma chave: quem comprometesse o segredo de sessão decifraria dado pessoal.
 *
 * O dono confirmou em 17/08/2026 que a variável está preenchida no painel do Render, e é isso que permite
 * a recusa em produção. Estes testes travam as DUAS metades: recusa onde há dado real, e queda tolerada
 * onde não há — porque exigir a variável em toda máquina quebraria a suíte e o primeiro `npm run dev` de
 * quem clona o repositório, sem proteger nada.
 */

/** CPF gerado para teste (nunca de pessoa real) — o mesmo que o resto da suíte usa. */
const CPF_DE_TESTE = "52998224725";

describe("⚠️ FIELD_ENCRYPTION_KEY ausente (achado M-1)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /**
   * Carrega `crypto.ts` com um ambiente inventado.
   *
   * `crypto.ts` lê `env` no momento da chamada, e `env` é construído ao carregar o módulo — daí o
   * `resetModules` antes de cada caso, senão o segundo teste receberia o módulo do primeiro.
   */
  const comAmbiente = async (fieldEncryptionKey: string, isProd: boolean) => {
    vi.doMock("../src/lib/env", () => ({
      env: {
        fieldEncryptionKey,
        isProd,
        authSecret: "segredo-de-sessao-so-para-teste-longo-o-bastante",
      },
    }));
    return await import("../src/lib/crypto");
  };

  it("⚠️ em PRODUÇÃO, recusa cifrar em vez de derivar a chave do AUTH_SECRET", async () => {
    const { encryptField } = await comAmbiente("", true);

    /**
     * Recusar é melhor do que gravar: um cadastro que falha gera um erro que alguém conserta em minutos;
     * um CPF gravado com a chave errada é ilegível para sempre e ninguém percebe até precisar dele.
     */
    expect(() => encryptField(CPF_DE_TESTE)).toThrow(/FIELD_ENCRYPTION_KEY ausente em PRODUÇÃO/);
  });

  it("em desenvolvimento continua funcionando — máquina nova e a suíte não quebram", async () => {
    const { encryptField, decryptField } = await comAmbiente("", false);

    const cifrado = encryptField(CPF_DE_TESTE);
    expect(cifrado).not.toContain(CPF_DE_TESTE);
    expect(decryptField(cifrado)).toBe(CPF_DE_TESTE);
  });

  it("com a chave configurada, produção cifra e decifra normalmente", async () => {
    const chave = Buffer.alloc(32, 7).toString("base64");
    const { encryptField, decryptField } = await comAmbiente(chave, true);

    const cifrado = encryptField(CPF_DE_TESTE);
    expect(cifrado).not.toContain(CPF_DE_TESTE);
    expect(decryptField(cifrado)).toBe(CPF_DE_TESTE);
  });

  it("chave de tamanho errado é recusada — 16 bytes não são 32", async () => {
    const { encryptField } = await comAmbiente(Buffer.alloc(16, 7).toString("base64"), true);

    expect(() => encryptField(CPF_DE_TESTE)).toThrow(/32 bytes/);
  });

  it("⚠️ dado cifrado com a chave DERIVADA não abre com a chave configurada", async () => {
    /**
     * Este é o prejuízo que a recusa evita, medido: cifrar sem a variável e depois configurá-la deixa o
     * dado antigo ilegível. É o mesmo efeito de trocar o `AUTH_SECRET`.
     */
    const { encryptField } = await comAmbiente("", false);
    const cifradoSemChave = encryptField(CPF_DE_TESTE);

    vi.resetModules();
    const { decryptField } = await comAmbiente(Buffer.alloc(32, 7).toString("base64"), false);

    /** Não decifra: ou lança, ou devolve algo que não é o CPF. Os dois são perda de dado. */
    let recuperado: string | null = null;
    try {
      recuperado = decryptField(cifradoSemChave);
    } catch {
      recuperado = null;
    }
    expect(recuperado).not.toBe(CPF_DE_TESTE);
  });
});
