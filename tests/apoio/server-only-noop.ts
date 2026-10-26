/**
 * Neutraliza `server-only` DENTRO DA SUÍTE DE TESTES.
 *
 * ── Por que isto existe ───────────────────────────────────────────────────────
 * `src/lib/db.ts` e `src/lib/env.ts` declaram `import "server-only"`. Essa linha é a trava que impede o
 * cliente do banco e o módulo de variáveis de ambiente de serem empacotados para o NAVEGADOR — defeito
 * que a auditoria de 16/08/2026 encontrou no pacote de produção. A trava funciona porque o Next troca o
 * pacote por um arquivo vazio na compilação do servidor e o deixa lançar na do navegador: repetir o erro
 * passa a QUEBRAR O BUILD.
 *
 * Fora do Next, o pacote lança sempre. E o vitest não é o Next: sem este apelido, os 52 arquivos de teste
 * que alcançam `db.ts` param de carregar com "This module cannot be imported from a Client Component".
 *
 * ── Por que neutralizar não enfraquece a trava ────────────────────────────────
 * A trava protege o LIMITE ENTRE SERVIDOR E NAVEGADOR, e esse limite é decidido na compilação do Next.
 * No processo de teste nós somos o servidor: não há pacote de navegador para vazar. A prova da trava é
 * outra e foi feita — apontar `analysis-actions.tsx` de volta para o módulo de servidor produz
 * "Failed to compile". `tests/hardening-etapa-1.test.ts` guarda a linha para que ninguém a remova.
 */
export {};
