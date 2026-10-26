import { env } from "../env";
import { processAnalysis } from "../analysis-runner";
import { ANALYSIS_QUEUE } from "./queue";

/**
 * Worker BullMQ dedicado. Execute com `npm run worker` (processo separado do web).
 * Só é necessário quando QUEUE_DRIVER=bullmq. Requer Redis (REDIS_URL).
 */
async function main() {
  if (env.queue.driver !== "bullmq") {
    console.log(`[worker] QUEUE_DRIVER=${env.queue.driver} — worker BullMQ desnecessário. Encerrando.`);
    return;
  }

  const { Worker } = (await import("bullmq")) as unknown as {
    Worker: new (
      name: string,
      processor: (job: { id?: string; data: unknown }) => Promise<void>,
      opts: unknown,
    ) => { on: (evt: string, cb: (...args: unknown[]) => void) => void };
  };
  const IORedis = ((await import("ioredis")) as unknown as { default: new (url: string, opts?: unknown) => unknown }).default;
  const connection = new IORedis(env.queue.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker(
    ANALYSIS_QUEUE,
    async (job) => {
      /**
       * `opcoes` pode não existir em trabalhos enfileirados antes deste campo — o
       * padrão vazio mantém o comportamento de cobrar, que é o do cliente.
       */
      const { analysisId, opcoes } = job.data as { analysisId: string; opcoes?: { cobrarCliente?: boolean } };
      console.log(`[worker] processando análise ${analysisId} (job ${job.id})`);
      await processAnalysis(analysisId, opcoes ?? {});
    },
    { connection, concurrency: env.queue.concurrency },
  );

  worker.on("completed", (job) => console.log(`[worker] concluído: ${(job as { id?: string })?.id}`));
  worker.on("failed", (job, err) => console.error(`[worker] falhou ${(job as { id?: string })?.id}:`, (err as Error)?.message));

  console.log(`[worker] escutando "${ANALYSIS_QUEUE}" (concorrência ${env.queue.concurrency}) em ${env.queue.redisUrl}`);
}

main().catch((e) => {
  console.error("[worker] erro fatal:", e);
  process.exit(1);
});
