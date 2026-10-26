import type { AnalysisStatus } from "@prisma/client";

/**
 * Constantes da execução de uma análise — módulo PURO, de propósito.
 *
 * ── ⚠️ POR QUE ESTE ARQUIVO EXISTE ────────────────────────────────────────────
 * Estas duas constantes moravam em `analise-travada.ts`, que importa o cliente do banco, o módulo de
 * variáveis de ambiente, a auditoria e o envio de e-mail. E `analysis-actions.tsx` — um componente que
 * roda no NAVEGADOR — importava `STATUS_EM_EXECUCAO` de lá só para saber quando parar de recarregar a
 * tela.
 *
 * O empacotador não recorta: importar uma constante de um módulo arrasta o módulo inteiro e tudo que ele
 * importa. Resultado, confirmado no pacote de produção construído: `PrismaClient` e o objeto de variáveis
 * de ambiente iam para o JavaScript entregue ao navegador, junto de uma chave que estava escrita em
 * `env.ts` como valor padrão.
 *
 * Nenhum segredo vazou — o Next substitui `process.env` por objeto vazio no navegador, e conferimos os
 * valores um por um. O que vazava era a estrutura interna e, principalmente, a POSSIBILIDADE: no dia em
 * que alguém escrevesse `get("OPENAI_API_KEY", "sk-...")` seguindo o padrão que já existia, aquela chave
 * seguiria este mesmo caminho até o navegador, em silêncio, com o build passando.
 *
 * ── A regra que este arquivo estabelece ───────────────────────────────────────
 * Constante que o navegador precisa conhecer mora em módulo SEM import de servidor. `import type` não
 * conta: o compilador apaga a linha, e é por isso que o tipo do Prisma aqui é inofensivo.
 *
 * `src/lib/db.ts` e `src/lib/env.ts` passaram a declarar `import "server-only"`. Repetir este erro agora
 * QUEBRA O BUILD em vez de vazar — que é a única forma de garantia que sobrevive à próxima manutenção.
 */

/**
 * Estados em que a análise está sob execução — nenhum deles é estado de repouso.
 *
 * Usado no servidor (para destravar execução morta) e no navegador (para saber quando parar de
 * recarregar a tela). É por precisar dos dois lados que ela mora aqui.
 */
export const STATUS_EM_EXECUCAO: AnalysisStatus[] = [
  "VALIDANDO_DOCUMENTOS",
  "EXTRAINDO_INFORMACOES",
  "PROCESSANDO",
];

/**
 * Depois de quantos minutos sem sinal de vida uma execução é considerada MORTA.
 *
 * O sinal é `Analysis.heartbeatAt`, gravado pelo motor a cada etapa e a cada documento extraído. Trinta
 * minutos é folgado de propósito: a extração de um documento é limitada pelo teto de páginas do OCR e a
 * chamada de IA pelo tempo limite do provedor. Errar para o lado curto seria pior que o defeito original
 * — mataria execução viva e devolveria crédito de análise que ia terminar.
 */
export const MINUTOS_SEM_SINAL_DE_VIDA = 30;
