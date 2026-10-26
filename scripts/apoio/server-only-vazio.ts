/**
 * Módulo vazio que substitui `server-only` NOS SCRIPTS NODE.
 *
 * `src/lib/db.ts` e `src/lib/env.ts` declaram `import "server-only"` — a trava que faz o build QUEBRAR se
 * o cliente do Prisma ou as variáveis de ambiente forem parar no pacote do navegador. Ela funciona porque
 * o Next resolve o pacote para um arquivo vazio no build do servidor e o deixa lançar no do navegador.
 *
 * Fora do Next, o pacote lança sempre. E os scripts de operação (boot do contêiner, rotina diária de
 * créditos, worker, scripts de pagamento) são Node puro: eles importam `db.ts` e morriam ao carregar.
 * Foi o que derrubou todos os deploys entre 17/08 e 02/09/2026.
 *
 * ── Por que um tsconfig separado, e não a condição `react-server` ─────────────
 * A primeira tentativa foi `tsx --conditions=react-server`, que é o mecanismo do próprio pacote. Ela
 * resolve o `server-only`, mas faz o REACT resolver para `react.shared-subset`, que se recusa a rodar
 * fora dos canais experimentais — a rotina de créditos passou a morrer por outro motivo. O apelido em
 * `tsconfig.scripts.json` troca UM pacote e nada mais.
 *
 * Como o Next lê `tsconfig.json` e nunca este arquivo, a trava do navegador continua de pé: quem tentar
 * importar o banco de dentro de uma tela continua quebrando o build.
 */
export {};
