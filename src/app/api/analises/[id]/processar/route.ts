import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireAppContext, getAnalysisForContext, assertActiveSubscription } from "@/lib/tenant";
import { agentRateAllowed } from "@/lib/rate-limit";
import { enqueueAnalysis } from "@/lib/queue/queue";
import { orcamentoDaAnalise, orcamentoParaJson } from "@/lib/orcamento";
import { destravarSeAbandonada, STATUS_EM_EXECUCAO } from "@/lib/analise-travada";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
// No modo "sync", o processamento roda aqui; em "async"/"bullmq" retorna rápido.
export const maxDuration = 300;

/** Quantas vezes a mesma análise pode ser reprocessada sem nova cobrança. */
const MAX_REPROCESSAMENTOS = 3;

export const POST = route(async (req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const ctx = await requireAppContext();
  // Gate NO SERVIDOR: exige assinatura ativa (isento para equipe interna).
  assertActiveSubscription(ctx);
  // Uso justo: barra flood/automação sem afetar uso humano normal.
  if (!agentRateAllowed(ctx.user.id, "process"))
    return fail("Muitas solicitações em pouco tempo. Aguarde alguns segundos e tente novamente.", 429);
  /**
   * A trava de saldo é o ORÇAMENTO, mais abaixo, e não `ctx.quota.allowed`.
   *
   * `quota.allowed` responde apenas "sobrou algum crédito?". Aplicada aqui, ela barrava
   * a reexecução GRATUITA de uma análise já paga sempre que o cliente tivesse zerado a
   * cota — contrariando a regra do próprio produto, que promete reprocessar sem cobrar
   * de novo depois de uma correção técnica. Justamente quem gastou tudo é quem mais
   * precisa reexecutar a análise que já pagou.
   *
   * O orçamento decide melhor porque sabe QUANTO falta cobrar: zero na reexecução do
   * mesmo material, e a diferença quando os documentos mudaram de faixa.
   */

  const analysis = await getAnalysisForContext(params.id, ctx);
  if (!analysis) return fail("Análise não encontrada.", 404);
  if (analysis.ownerId !== ctx.user.id && ctx.user.role !== "ADMIN") return fail("Sem permissão.", 403);

  /**
   * ⚠️ QUEM PAGA É O CLIENTE — então quem não é o cliente não gasta o crédito dele.
   *
   * A cobrança acontecia por conta própria: o motor debitava a assinatura da organização
   * da análise, sem olhar quem havia disparado. Um revisor ou o suporte abrindo a análise
   * e clicando em "Reprocessar" gastava crédito DO CLIENTE, sem pedir nada a ninguém — e
   * com a cobrança da diferença de faixa ficou mais caro: a equipe acrescenta um documento
   * para ajudar no atendimento, o processo sobe de faixa, e o cliente é debitado por um
   * trabalho que ele não pediu.
   *
   * Cliente disparando: cobra, como sempre — é a análise dele, pedida por ele. Equipe
   * interna: NÃO cobra, porque revisão e suporte são trabalho nosso. Cobrar em nome do
   * cliente continua possível — o caso do suporte reprocessando com documentos que o
   * próprio cliente mandou —, mas exige dizer isso explicitamente no pedido.
   */
  const ehCliente = ctx.user.role === "CLIENTE";
  const corpo = await req
    .json()
    .then((j) => (j ?? {}) as { cobrarCliente?: boolean })
    .catch(() => ({}) as { cobrarCliente?: boolean });
  const cobrarCliente = ehCliente ? true : corpo.cobrarCliente === true;

  /**
   * ⚠️ "Já está em processamento" era um beco sem saída.
   *
   * Quando o processo morre no meio — deploy, tempo limite da requisição, falta de
   * memória —, o `catch` de `processAnalysis` não roda: o status fica preso em
   * PROCESSANDO, o crédito fica debitado e esta recusa por 409 impedia qualquer nova
   * tentativa. O cliente pagava, não recebia nada e não tinha nem o botão de tentar de
   * novo. Destravar aqui é o que transforma isso num botão que funciona — e devolve o
   * crédito no caminho. Ver src/lib/analise-travada.ts.
   */
  if (STATUS_EM_EXECUCAO.includes(analysis.status)) {
    const r = await destravarSeAbandonada(analysis.id);
    if (!r.destravada) return fail("A análise já está em processamento.", 409);
  }

  /**
   * ⚠️ ANÁLISE ENCERRADA NÃO VOLTA A PROCESSAR — e isto é trava de DINHEIRO, não de organização.
   *
   * Cancelar devolve o crédito quando não houve entrega (ver `src/lib/situacao-da-analise.ts`). E a
   * idempotência da cobrança pergunta se existe consumo NÃO ESTORNADO — de propósito, para a análise
   * que falhou e foi estornada poder ser cobrada de novo quando o cliente reexecuta.
   *
   * As duas regras juntas abriam uma cobrança indevida: o cliente cancela, recebe o crédito de volta,
   * e um clique em "Reprocessar" — o botão continuava na tela — debitava o crédito OUTRA VEZ por uma
   * análise que ele mesmo encerrou. Cobrança que o cliente não reconhece é o caminho mais curto para
   * um estorno no cartão, que custa muito mais que o crédito.
   *
   * A tela já esconde o botão; esta é a trava que vale, porque a tela não é a regra.
   */
  if (analysis.status === "CANCELADA" || analysis.status === "ARQUIVADA") {
    return fail(
      analysis.status === "CANCELADA"
        ? "Esta análise foi cancelada. Para retomá-la, fale com o suporte — reprocessar uma análise" +
          " cancelada debitaria o crédito que foi devolvido a você."
        : "Esta análise está arquivada. Desarquive-a antes de reprocessar.",
      409,
      { reason: "analise_encerrada" },
    );
  }

  /**
   * Trava de saldo NO SERVIDOR. A tela já mostra o custo e o saldo, mas conferir só lá
   * deixaria a chamada de IA a um `fetch` de distância — e cada chamada custa dinheiro.
   * Aqui é onde a regra vale.
   *
   * ⚠️ A conferência era PULADA quando a análise já tinha cobrança
   * (`creditsCharged === 0`), e isso abria um caminho para uso gratuito ilimitado: o
   * cliente enviava 200 páginas (1 crédito), processava, ACRESCENTAVA 700 páginas e
   * reprocessava. O processo passava a custar 4 créditos pela tabela de faixas e saía
   * por 1 — sem trava de saldo nenhuma, inclusive com saldo zero.
   *
   * O orçamento agora sabe o que já foi pago (ver `orcamentoDaAnalise`): reprocessar o
   * MESMO material tem `aCobrar` zero e continua passando de graça, como o produto
   * promete; material que cresceu de faixa precisa de saldo para a DIFERENÇA.
   */
  if (ctx.user.role === "CLIENTE") {
    const orcamento = await orcamentoDaAnalise(analysis.id, ctx.subscription);
    if (orcamento.custo.bloqueado) {
      return fail(orcamento.mensagem, 422, { reason: "processo_acima_do_limite", orcamento: orcamentoParaJson(orcamento) });
    }
    if (!orcamento.podeIniciar) {
      return fail(orcamento.mensagem, 402, { reason: "sem_creditos", orcamento: orcamentoParaJson(orcamento) });
    }
  }

  // Conter reprocessamento ilimitado: cada reprocesso é uma chamada de IA paga
  // pela Leão Amorim, e a análise já foi cobrada uma vez só.
  if (analysis.reprocessCount >= MAX_REPROCESSAMENTOS && ctx.user.role === "CLIENTE") {
    return fail(
      `Esta análise já foi reprocessada ${MAX_REPROCESSAMENTOS} vezes. ` +
        `Para uma nova apuração, inicie uma análise nova ou fale com o suporte.`,
      429,
      { reason: "limite_reprocessamento" },
    );
  }

  await logAudit({
    actorId: ctx.user.id,
    action: "analysis.process_requested",
    entityType: "Analysis",
    entityId: analysis.id,
    // Quem pediu e se o cliente foi cobrado: é o que permite auditar depois um débito
    // que o cliente não reconhece.
    metadata: { papel: ctx.user.role, cobrarCliente },
  });

  // Marca como PROCESSANDO para feedback imediato (o cliente faz polling do status).
  // Só conta como reprocessamento quando a análise já rodou antes — a primeira
  // execução de um rascunho não é reprocesso.
  const jaRodou = analysis.completedAt !== null || analysis.creditsCharged > 0;
  await prisma.analysis.update({
    where: { id: analysis.id },
    data: {
      status: "PROCESSANDO",
      /**
       * ⚠️ O SINAL DE VIDA É RENOVADO AQUI, e a falta disso fazia a análise nascer "abandonada".
       *
       * `semSinalDeVida` usa `heartbeatAt` quando ele existe — e numa análise que já rodou antes ele é
       * da execução ANTERIOR, de horas ou dias atrás. Sem renovar, no segundo seguinte ao
       * enfileiramento a análise já satisfazia o critério de "execução morta há mais de 30 minutos".
       *
       * Duas consequências, ambas de dinheiro:
       *  - a varredura de manutenção matava a execução VIVA e devolvia o crédito de uma análise que ia
       *    terminar — o próprio comentário de `MINUTOS_SEM_SINAL_DE_VIDA` diz que errar para o lado
       *    curto é pior que o defeito original, e era o que acontecia em todo reprocessamento;
       *  - com o cancelamento implementado, o botão "Cancelar análise" aparecia no meio do
       *    processamento: o cliente cancelava, recebia o crédito de volta, e o motor entregava o
       *    relatório minutos depois. Análise entregue de graça.
       *
       * O motor regrava `heartbeatAt` a cada etapa (`sinalDeVida`), mas só quando começa a trabalhar —
       * e a janela entre enfileirar e começar é justamente onde a fila espera.
       */
      heartbeatAt: new Date(),
      ...(jaRodou ? { reprocessCount: { increment: 1 } } : {}),
    },
  });

  try {
    const result = await enqueueAnalysis(analysis.id, { cobrarCliente });
    const semCobranca = !cobrarCliente ? " O crédito do cliente NÃO foi debitado." : "";
    if (result === "processed") {
      return ok({
        status: "AGUARDANDO_REVISAO",
        cobrarCliente,
        message: `Análise processada. Aguardando revisão.${semCobranca}`,
      });
    }
    return ok({
      status: "PROCESSANDO",
      cobrarCliente,
      message: `Análise enfileirada. Acompanhe o andamento.${semCobranca}`,
    });
  } catch (err) {
    await prisma.analysis.update({ where: { id: analysis.id }, data: { status: "ERRO_PROCESSAMENTO" } });
    return fail(`Falha ao enfileirar o processamento: ${(err as Error).message}`, 500);
  }
});
