import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Todo ponto de entrada Node precisa do `tsconfig.scripts.json`.
 *
 * ── O incidente que este arquivo existe para não repetir ──────────────────────
 * Em 17/08/2026 a etapa 1 do endurecimento acrescentou `import "server-only"` a `src/lib/db.ts` e
 * `src/lib/env.ts`. A trava faz o que promete: importar o banco de dentro de código de navegador passa a
 * QUEBRAR O BUILD em vez de vazar o cliente do Prisma para o JavaScript público.
 *
 * O que ninguém previu é que `server-only` também lança em Node puro: quem o neutraliza é o Next, dentro
 * do próprio build, e nenhum script avulso de Node faz isso por conta.
 *
 * O comando de start do contêiner é
 * `npx prisma migrate deploy && npx tsx scripts/sincronizar-catalogo.ts --boot && node server.js`.
 * O script do meio importa `db.ts`, o `server-only` lançou, o processo saiu com status 1, e o Render
 * abortou o deploy — TODAS as vezes. Produção passou 22 dias (11/08 a 02/09) servindo um build antigo,
 * com seis commits de segurança publicados no repositório e nenhum deles no ar. Junto pararam a rotina
 * diária de manutenção de créditos (`render.yaml`), o worker da fila e os scripts de pagamento.
 *
 * ── Por que o build não pegou, e por que a suíte também não ───────────────────
 * `next build` compila sem erro: a falha é ao INICIAR, não ao compilar. E a suíte não pegava porque o
 * `vitest.config.ts` neutraliza `server-only` por apelido — decisão correta para o teste, que roda no
 * servidor, mas que apagava justamente o sinal.
 *
 * Este teste é o que fecha a lacuna: ele lê os arquivos de configuração e recusa qualquer invocação de
 * `tsx` sem o apelido, exige que a imagem leve o arquivo, e confirma que a trava do navegador continua no
 * lugar. Não depende de ninguém lembrar da regra — que é exatamente o que falhou.
 */

/** Remove comentários de YAML/Dockerfile antes de afirmar — comentário não executa. */
const semComentariosDeShell = (fonte: string) =>
  fonte
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("#"))
    .join("\n");

const MECANISMO = "--tsconfig tsconfig.scripts.json";

/**
 * ⚠️ A primeira tentativa de conserto foi `tsx --conditions=react-server`, o mecanismo do próprio pacote
 * `server-only`. Ela resolve o `server-only` e QUEBRA O REACT: com essa condição, `react` resolve para
 * `react.shared-subset`, que se recusa a rodar fora dos canais experimentais — a rotina diária de créditos
 * passou a morrer por outro motivo. Descobri rodando a rotina de verdade contra o banco descartável.
 *
 * O apelido em `tsconfig.scripts.json` troca UM pacote e nada mais, e o Next nunca lê aquele arquivo, então
 * a trava do navegador continua de pé. Este teste recusa a volta da condição.
 */
const MECANISMO_PROIBIDO = "--conditions=react-server";

/** Casa `tsx caminho/arquivo.ts`, que é como todo ponto de entrada é escrito aqui. */
const INVOCACAO = /\btsx\s+([^\n"']*?)(prisma|scripts|src)\/\S+\.ts\b/g;

describe("⚠️ pontos de entrada Node e o server-only", () => {
  const arquivos = [
    { nome: "package.json", limpar: (s: string) => s },
    { nome: "Dockerfile", limpar: semComentariosDeShell },
    { nome: "render.yaml", limpar: semComentariosDeShell },
  ];

  for (const { nome, limpar } of arquivos) {
    it(`${nome}: nenhuma invocação de tsx sem o apelido`, () => {
      const fonte = limpar(readFileSync(nome, "utf8"));
      const semCondicao: string[] = [];

      for (const achado of fonte.matchAll(INVOCACAO)) {
        const invocacao = achado[0];
        if (!invocacao.includes(MECANISMO)) semCondicao.push(invocacao.trim());
      }

      expect(semCondicao, `sem ${MECANISMO}: ${semCondicao.join(" | ")}`).toEqual([]);
      expect(fonte, "a condição react-server quebra o React — ver o comentário").not.toContain(MECANISMO_PROIBIDO);
    });
  }

  it("⚠️ o comando de start roda o boot ANTES do site — e ele precisa do apelido", () => {
    /**
     * É esta linha específica que derrubou os deploys: o `&&` faz o site só subir se o boot terminar bem,
     * então um erro ali não degrada nada — impede o deploy inteiro.
     */
    const dockerfile = semComentariosDeShell(readFileSync("Dockerfile", "utf8"));
    const cmd = /CMD \[.*\]/.exec(dockerfile)?.[0] ?? "";

    expect(cmd).toContain("sincronizar-catalogo.ts");
    expect(cmd).toContain(MECANISMO);
    expect(cmd).toContain("node server.js");
  });

  it("a rotina diária de créditos também é um ponto de entrada Node", () => {
    /** Ela roda como Cron Job do Render, fora do contêiner do site, e quebrou junto sem ninguém notar. */
    const render = semComentariosDeShell(readFileSync("render.yaml", "utf8"));
    const cron = /dockerCommand:.*manutencao-creditos\.ts/.exec(render)?.[0] ?? "";

    expect(cron).not.toBe("");
    expect(cron).toContain(MECANISMO);
  });

  it("⚠️ a imagem leva o tsconfig dos scripts — senão o contêiner não sobe", () => {
    /**
     * Esta é a pedra em que quase tropecei duas vezes. O estágio final do Dockerfile copia arquivo por
     * arquivo: `tsconfig.json` e `scripts/` já vinham, mas `tsconfig.scripts.json` é arquivo NOVO. Sem o
     * COPY, o boot falharia com "tsconfig não encontrado" e o deploy quebraria pelo mesmo lugar, por um
     * motivo diferente — depois de 22 dias de produção parada pela primeira versão do problema.
     */
    const dockerfile = semComentariosDeShell(readFileSync("Dockerfile", "utf8"));

    /**
     * ⚠️ Precisa estar no ÚLTIMO estágio, e a primeira versão deste teste não checava isso.
     *
     * O Dockerfile tem três estágios (`deps`, `builder`, `runner`) e só o último vira a imagem que roda.
     * Um `COPY` no `builder` passaria neste teste e o contêiner subiria sem o arquivo — o mesmo deploy
     * quebrado, com o teste verde. Por isso a posição é medida, não só a existência.
     */
    const ultimoEstagio = dockerfile.slice(dockerfile.lastIndexOf("FROM "));

    expect(ultimoEstagio, "COPY do tsconfig.scripts.json fora do estágio final").toMatch(
      /COPY .*tsconfig\.scripts\.json/,
    );
  });

  it("o apelido do tsconfig dos scripts aponta para um módulo que existe", () => {
    const config = JSON.parse(readFileSync("tsconfig.scripts.json", "utf8"));
    const destino = config.compilerOptions?.paths?.["server-only"]?.[0];

    expect(destino, "tsconfig.scripts.json sem apelido para server-only").toBeTruthy();
    /** Se o arquivo for renomeado sem atualizar o apelido, o boot volta a morrer. */
    expect(() => readFileSync(String(destino).replace(/^\.\//, ""), "utf8")).not.toThrow();
  });

  it("⚠️ o Next NÃO usa o tsconfig dos scripts — a trava do navegador continua valendo", () => {
    /** Se o apelido entrasse no `tsconfig.json`, o build do navegador também o receberia e a trava morreria. */
    const principal = JSON.parse(readFileSync("tsconfig.json", "utf8"));

    expect(principal.compilerOptions?.paths?.["server-only"]).toBeUndefined();
  });

  it("⚠️ a trava continua nos dois módulos — o conserto não pode ter sido apagá-la", () => {
    /**
     * O caminho fácil, ao ver o deploy falhar, é remover `import "server-only"` e seguir a vida. Isso
     * reabriria o vazamento que a etapa 1 fechou: o cliente do Prisma e as variáveis de ambiente voltariam
     * a poder ser empacotados para o navegador. A condição existe para manter as duas coisas.
     */
    const semComentariosDeTs = (fonte: string) =>
      fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const arquivo of ["src/lib/db.ts", "src/lib/env.ts"]) {
      expect(semComentariosDeTs(readFileSync(arquivo, "utf8")), arquivo).toContain('import "server-only"');
    }
  });
});
