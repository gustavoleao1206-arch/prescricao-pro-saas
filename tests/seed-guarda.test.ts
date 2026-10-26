import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { problemasDoSeed, SENHAS_DE_DEMONSTRACAO, TAMANHO_MINIMO_SENHA_ADMIN_PRODUCAO } from "../prisma/seed-guarda";

/**
 * A trava do seed em produção (prisma/seed-guarda.ts).
 *
 * O seed não roda na suíte — exigiria banco e criaria dado —, por isso a regra mora numa função pura e é ela
 * que se testa aqui. O último bloco confere que o seed de fato a chama, e antes da primeira escrita.
 */

const SENHA_FORTE = "Xq7!vR2#mL9$tK4p";

describe("⚠️ em produção o seed recusa senha de demonstração", () => {
  it.each(SENHAS_DE_DEMONSTRACAO)("recusa %s", (senha) => {
    const problemas = problemasDoSeed({ producao: true, senhaAdmin: senha, semearDemo: false });
    expect(problemas.some((p) => p.includes("senha de demonstração"))).toBe(true);
  });

  it("recusa variações de caixa e espaço da senha publicada", () => {
    for (const senha of ["admin@demo123", "ADMIN@DEMO123", " Admin@Demo123 "]) {
      expect(problemasDoSeed({ producao: true, senhaAdmin: senha, semearDemo: false }).length).toBeGreaterThan(0);
    }
  });

  it("recusa a família <Papel>@Demo mesmo com outro número", () => {
    const problemas = problemasDoSeed({ producao: true, senhaAdmin: "Admin@Demo2026!xyz", semearDemo: false });
    expect(problemas.some((p) => p.includes("senha de demonstração"))).toBe(true);
  });
});

describe("⚠️ em produção o seed recusa senha fraca para o administrador", () => {
  it(`recusa senha com menos de ${TAMANHO_MINIMO_SENHA_ADMIN_PRODUCAO} caracteres`, () => {
    const curta = "Ab1!efghijk"; // 11 caracteres, passa na composição
    expect(curta.length).toBe(TAMANHO_MINIMO_SENHA_ADMIN_PRODUCAO - 1);
    const problemas = problemasDoSeed({ producao: true, senhaAdmin: curta, semearDemo: false });
    expect(problemas).toEqual([`SEED_ADMIN_PASSWORD precisa ter ao menos ${TAMANHO_MINIMO_SENHA_ADMIN_PRODUCAO} caracteres em produção.`]);
  });

  it("recusa senha longa sem a composição exigida pela política do sistema", () => {
    const problemas = problemasDoSeed({ producao: true, senhaAdmin: "senhasomenteminuscula", semearDemo: false });
    expect(problemas.length).toBe(3); // maiúscula, número e símbolo
  });

  it("devolve todos os problemas de uma vez, sem repetir o de tamanho", () => {
    const problemas = problemasDoSeed({ producao: true, senhaAdmin: "abc", semearDemo: true });
    expect(problemas.filter((p) => p.includes("caracteres"))).toHaveLength(1);
    expect(problemas.some((p) => p.includes("SEED_DEMO=true"))).toBe(true);
  });

  it("aceita senha forte e sem demonstração", () => {
    expect(problemasDoSeed({ producao: true, senhaAdmin: SENHA_FORTE, semearDemo: false })).toEqual([]);
  });
});

describe("⚠️ em produção o seed recusa criar as contas de demonstração", () => {
  it("SEED_DEMO=true é recusado mesmo com senha de administrador forte", () => {
    const problemas = problemasDoSeed({ producao: true, senhaAdmin: SENHA_FORTE, semearDemo: true });
    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain("SEED_DEMO=true");
  });
});

describe("fora de produção nada muda", () => {
  it("desenvolvimento aceita as contas e a senha de demonstração", () => {
    expect(problemasDoSeed({ producao: false, senhaAdmin: "Admin@Demo123", semearDemo: true })).toEqual([]);
  });
});

describe("o seed chama a trava antes de escrever", () => {
  const semComentarios = (texto: string) =>
    texto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const codigo = semComentarios(readFileSync("prisma/seed.ts", "utf8"));

  it("problemasDoSeed é chamado e interrompe o seed com erro", () => {
    expect(codigo).toMatch(/problemasDoSeed\(\{\s*producao,\s*senhaAdmin:\s*adminPass,\s*semearDemo\s*\}\)/);
    expect(codigo).toMatch(/if \(problemas\.length > 0\) \{\s*throw new Error/);
  });

  it("a chamada vem antes da primeira escrita no banco", () => {
    /** Só o corpo de main(): as funções auxiliares acima dela escrevem, mas só são chamadas depois da trava. */
    const main = codigo.slice(codigo.indexOf("async function main()"));
    const trava = main.indexOf("problemasDoSeed(");
    const primeiraEscrita = main.search(/prisma\.\w+\.(upsert|create|createMany|update|updateMany|delete|deleteMany)\(|semearConteudoSite\(/);
    expect(trava).toBeGreaterThan(-1);
    expect(primeiraEscrita).toBeGreaterThan(-1);
    expect(trava).toBeLessThan(primeiraEscrita);
  });

  it("a senha do administrador não é impressa na saída do seed", () => {
    expect(codigo).not.toMatch(/console\.\w+\([^)]*adminPass/);
  });
});
