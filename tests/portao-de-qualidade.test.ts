import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

/**
 * O portão de qualidade do GitHub.
 *
 * ── Por que um teste sobre um arquivo de configuração ─────────────────────────
 * Um portão é a coisa mais fácil de esvaziar sem ninguém notar: basta apagar o passo dos testes para ele
 * ficar verde para sempre. Estes testes existem para que esvaziá-lo derrube a própria suíte que ele roda.
 *
 * ⚠️ O que estes testes NÃO garantem: que o portão está EXIGIDO no GitHub. Isso é configuração da conta, não
 * do repositório, e só o dono liga — em Settings → Branches, na proteção da `main`. Enquanto não estiver
 * exigido, o portão fica verde ou vermelho ao lado do commit e o Render publica de qualquer forma.
 */

const CAMINHO = ".github/workflows/portao.yml";
const bruto = existsSync(CAMINHO) ? readFileSync(CAMINHO, "utf8") : "";

/**
 * ⚠️ Sem os comentários do YAML — MENÇÃO NÃO É CONFIGURAÇÃO.
 *
 * A primeira versão destes testes leu o arquivo cru e acusou o próprio comentário que explica POR QUE o
 * portão não usa o Postgres pronto do Actions (`services:`). Um teste que obriga a apagar a explicação para
 * ficar verde piora o arquivo: a explicação é o que impede alguém de "simplificar" o portão e perder a
 * garantia de rodar o mesmo comando da máquina do dono.
 */
const portao = bruto
  .split(/\r?\n/)
  .filter((linha) => !linha.trimStart().startsWith("#"))
  .join("\n");

describe("⚠️ o portão existe e roda as quatro verificações", () => {
  it("o arquivo do portão está no repositório", () => {
    expect(existsSync(CAMINHO), `${CAMINHO} não encontrado`).toBe(true);
  });

  it("roda em pull request E em push para main", () => {
    /** Só em pull request deixaria o push direto passar sem verificação — que é o estado que se conserta. */
    expect(portao).toMatch(/pull_request:/);
    expect(portao).toMatch(/branches:\s*\[main\]/);
  });

  it("⚠️ roda tipos, lint, testes e build — os quatro", () => {
    expect(portao).toContain("npm run typecheck");
    expect(portao).toContain("npm run lint");
    expect(portao).toContain("npm test");
    expect(portao).toContain("npm run build:check");
  });

  it("⚠️ roda `npm test`, o MESMO comando da máquina do dono", () => {
    /**
     * O Actions oferece um Postgres pronto, que seria mais simples. Mas `npm test` sobe o banco descartável
     * por conta própria, e é esse o comando que se roda localmente. Caminhos diferentes aqui e lá criam a
     * pior espécie de portão: o que fica verde enquanto o comando de verdade está quebrado.
     *
     * Não é hipótese: durante a etapa 2, uma alteração no `scripts/pg-teste.mjs` caiu no array errado e
     * quebrou o `npm test` inteiro — um portão apontado para outro caminho teria passado verde.
     */
    expect(portao).not.toContain("services:");
    expect(portao).toContain("PTP_PG_BASE");
  });

  it("instala com `npm ci`, que não reescreve o lockfile", () => {
    /** Portão que altera o lockfile mente sobre o que testou. */
    expect(portao).toContain("npm ci");
    expect(portao).not.toMatch(/run:\s*npm install/);
  });

  it("gera o cliente do Prisma antes de conferir tipos", () => {
    const ordem = (t: string) => portao.indexOf(t);
    expect(ordem("npx prisma generate")).toBeGreaterThan(0);
    expect(ordem("npx prisma generate")).toBeLessThan(ordem("npm run typecheck"));
  });

  it("⚠️ NÃO usa segredo nenhum", () => {
    /**
     * Os testes não falam com serviço externo (o vitest força EMAIL_DRIVER=console), e as duas variáveis do
     * passo de build são valores de fachada — os mesmos do Dockerfile. Segredo cadastrado num portão é
     * segredo a mais exposto, e aqui não é necessário.
     */
    expect(portao).not.toContain("secrets.");
  });

  it("não roda dentro de container — o Postgres se recusa a rodar como root", () => {
    expect(portao).toContain("runs-on: ubuntu-latest");
    expect(portao).not.toMatch(/^\s*container:/m);
  });

  it("tem teto de tempo, para não ficar pendurado consumindo minuto", () => {
    expect(portao).toMatch(/timeout-minutes:/);
  });
});

describe("⚠️ o build:check funciona nos três sistemas", () => {
  it("não usa prefixo de variável no estilo POSIX", () => {
    /**
     * Era `NEXT_DIST_DIR=.next-check next build`. Isso funciona no Mac, no Linux e no Actions, e NÃO funciona
     * no PowerShell do Windows — onde o comando falha antes de começar. A verificação existia e a máquina do
     * dono não conseguia rodá-la. Um projeto com uma pessoa no Windows e outra no Mac não pode ter comando
     * que só roda em um dos dois.
     */
    const pacote = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

    expect(pacote.scripts["build:check"]).not.toMatch(/[A-Z_]+=\S+\s+next/);
    expect(pacote.scripts["build:check"]).toContain("node scripts/build-check.mjs");
  });

  it("e continua gerando em diretório separado, para não derrubar o servidor local", () => {
    /** `next build` sobrescreve o `.next` que o `npm run dev` está usando. */
    expect(readFileSync("scripts/build-check.mjs", "utf8")).toContain('NEXT_DIST_DIR: ".next-check"');
  });
});
