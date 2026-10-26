import { env } from "../env";
import { processAnalysis, type OpcoesDoProcessamento } from "../analysis-runner";

/**
 * Fila de processamento de análises, com 3 drivers (env QUEUE_DRIVER):
 *  - "sync"   : processa na própria requisição (simples; adequado a serverless).
 *  - "async"  : fire-and-forget no processo Node (retorna rápido; exige servidor
 *               persistente — ex.: container standalone).
 *  - "bullmq" : enfileira no Redis; um worker dedicado consome (produção).
 *
 * BullMQ/ioredis são carregados por import dinâmico — só quando o driver é bullmq
 * —, de modo que instalações sync/async não dependem de Redis.
 */

export const ANALYSIS_QUEUE = "analises";

type BullQueueLike = { add: (name: string, data: unknown, opts?: unknown) => Promise<unknown> };
let bullQueue: BullQueueLike | null = null;

async function getBullQueue(): Promise<BullQueueLike> {
  if (bullQueue) return bullQueue;
  const { Queue } = (await import("bullmq")) as unknown as { Queue: new (name: string, opts: unknown) => BullQueueLike };
  const IORedis = ((await import("ioredis")) as unknown as { default: new (url: string, opts?: unknown) => unknown }).default;
  /**
   * ⚠️ Este é o lado que ENFILEIRA — roda dentro da requisição do cliente. Ele tem de falhar RÁPIDO.
   *
   * O padrão do ioredis é enfileirar comandos enquanto reconecta, indefinidamente. Com o Redis fora do
   * ar, `q.add` ficaria pendurado até o teto da rota (5 minutos), e o cliente veria a tela girar sem
   * resposta. Com `enableOfflineQueue: false` e um teto de conexão, o `add` rejeita em segundos, a rota
   * marca a análise com erro e devolve mensagem clara — e o crédito não é debitado, porque a cobrança só
   * acontece dentro de `processAnalysis`.
   *
   * `maxRetriesPerRequest: null` continua porque o BullMQ exige. O WORKER (worker.ts) não recebe estas
   * opções de propósito: lá o certo é esperar o Redis voltar, não desistir.
   */
  const connection = new IORedis(env.queue.redisUrl, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
  });
  bullQueue = new Queue(ANALYSIS_QUEUE, { connection });
  return bullQueue;
}

/**
 * `opcoes` viaja com o trabalho, e não gravada na análise, porque é decisão DAQUELA
 * execução: quem disparou e se o cliente deve ser cobrado. Guardar isso na linha da
 * análise faria a decisão de hoje valer para o reprocessamento de amanhã.
 */
export async function enqueueAnalysis(
  analysisId: string,
  opcoes: OpcoesDoProcessamento = {},
): Promise<"processed" | "queued"> {
  switch (env.queue.driver) {
    case "bullmq": {
      const q = await getBullQueue();
      await q.add(
        "process",
        { analysisId, opcoes },
        {
          attempts: env.queue.jobAttempts,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      );
      return "queued";
    }
    case "async": {
      // Executa em segundo plano; erros são tratados dentro de processAnalysis
      // (status ERRO_PROCESSAMENTO) e também logados aqui por garantia.
      void processAnalysis(analysisId, opcoes).catch((e) => console.error("[queue:async] falha", (e as Error).message));
      return "queued";
    }
    case "sync":
    default:
      await processAnalysis(analysisId, opcoes);
      return "processed";
  }
}
