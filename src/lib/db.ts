/**
 * ⚠️ `server-only` É A TRAVA, e é o que impede o defeito de voltar.
 *
 * Este módulo já foi entregue ao navegador uma vez: um componente de tela importou uma constante de
 * `analise-travada.ts`, que importa este arquivo, e o empacotador levou o cliente do Prisma inteiro para
 * o JavaScript público (confirmado no pacote de produção).
 *
 * Com esta linha, importar `db.ts` de qualquer código de navegador QUEBRA O BUILD com mensagem explícita,
 * em vez de compilar em silêncio e vazar. É a única forma de garantia que sobrevive à próxima manutenção:
 * ela não depende de ninguém lembrar da regra.
 *
 * ── ⚠️ O PREÇO DESTA LINHA, e ele já foi pago caro ────────────────────────────
 * `server-only` LANÇA ao ser carregado fora do Next. O Next o neutraliza dentro do próprio build; um
 * script avulso de Node não faz isso por conta.
 *
 * Consequência real: entre 17/08 e 02/09/2026 TODOS os deploys falharam, e produção ficou 22 dias servindo
 * o build de 11/08. O comando de start do contêiner executa
 * `npx tsx scripts/sincronizar-catalogo.ts --boot` antes de subir o site; esse script importa este
 * arquivo, o `server-only` lançou, o processo saiu com status 1 e o Render abortou o deploy. O sintoma no
 * painel é `Exited with status 1 while running your code` — e ele NÃO aparece em `next build`, que compila
 * normalmente. Junto foram a rotina diária de créditos, o worker e todos os scripts de pagamento.
 *
 * **Portanto: todo ponto de entrada Node que alcance este módulo roda com
 * `tsx --tsconfig tsconfig.scripts.json`**, que troca `server-only` por um módulo vazio APENAS nos
 * scripts — o Next lê `tsconfig.json` e nunca aquele arquivo, então a trava do navegador continua de pé.
 * Estão no `package.json`, no `CMD` do `Dockerfile` e no `dockerCommand` do `render.yaml`.
 *
 * Não use `tsx --conditions=react-server` para isso: resolve o `server-only` e faz o REACT resolver para
 * `react.shared-subset`, que se recusa a rodar fora dos canais experimentais — a rotina de créditos morre
 * por outro motivo. `tests/entradas-node.test.ts` recusa as duas regressões, porque lembrar da regra é
 * exatamente o que falhou da primeira vez.
 */
import "server-only";
import { PrismaClient } from "@prisma/client";

// Singleton do Prisma para evitar múltiplas conexões em hot-reload (dev).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
