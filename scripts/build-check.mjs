/**
 * `npm run build:check` — confere se o projeto COMPILA, sem estragar o `.next` do dia a dia.
 *
 * ── Por que existe este arquivo em vez de uma linha no package.json ───────────
 * O script era `NEXT_DIST_DIR=.next-check next build`. Esse prefixo é sintaxe de shell POSIX: funciona no
 * Mac e no Linux (e no Actions), e NÃO funciona no PowerShell do Windows — onde o comando falha antes de
 * começar. Ou seja, a verificação existia e a máquina do dono não conseguia rodá-la.
 *
 * Resolver com uma dependência (`cross-env`) seria uma linha, mas acrescentar pacote ao projeto por causa de
 * uma variável de ambiente é custo de supply chain que não se paga. Node define variável de ambiente em
 * qualquer sistema.
 *
 * ── Por que um diretório separado ─────────────────────────────────────────────
 * `next build` sobrescreve o `.next`, que é o que o `npm run dev` está usando. Conferir a compilação no meio
 * do trabalho derrubaria o servidor local; `.next-check` mantém os dois independentes.
 */
import { spawnSync } from "node:child_process";

const resultado = spawnSync("npx", ["next", "build"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, NEXT_DIST_DIR: ".next-check" },
});

process.exit(resultado.status ?? 1);
