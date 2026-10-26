import { prisma } from "./db";
import { getObject } from "./storage";
import { extractText, MIN_CHARS_PAGINA } from "./documents";
import { runAnalysis, buildReportMarkdown } from "./ai/analysis";
import { materiaPorTipo } from "./ai/materias";
import { recordAnalysisConsumption, getActiveSubscription } from "./consumption";
import { consumirCreditos, estornarCreditosDaAnalise, SaldoInsuficienteError } from "./credits";
import { alertarOperacao } from "./alerta-operacional";
import { orcamentoDaAnalise } from "./orcamento";
import { registrarUsoIA } from "./ai/custos";
import { sinalDeVida } from "./analise-travada";
import { logAudit } from "./audit";
import type { AnalysisStatus } from "@prisma/client";
import { cifrarTextoDaPagina, lerPaginasDoDocumento } from "./pagina-do-processo";

/**
 * Orquestra o processamento de uma análise, ponta a ponta, na metodologia da plataforma:
 *  validar -> extrair texto -> rodar análise (IA/heurística) -> persistir linha do
 *  tempo, relatório (seções 1-3) e a EXCEÇÃO DE PRÉ-EXECUTIVIDADE (peça principal)
 *  -> abrir revisão -> registrar consumo.
 *
 * MVP síncrono. Em produção, disparar via fila (BullMQ/Redis). Ver ARQUITETURA.md.
 */

/**
 * Troca de etapa É sinal de vida: grava `heartbeatAt` junto com o status.
 *
 * Sem isso, a varredura que devolve o crédito de execução abandonada (ver
 * src/lib/analise-travada.ts) veria heartbeat nulo durante toda a execução e poderia
 * tomar por morta uma análise que acabou de começar.
 */
async function setStatus(analysisId: string, status: AnalysisStatus) {
  await sinalDeVida(analysisId, status);
}

export interface OpcoesDoProcessamento {
  /**
   * Debitar créditos da assinatura do cliente?
   *
   * ── Por que isto é uma decisão, e não sempre "sim" ────────────────────────────
   * Quem paga a análise é o CLIENTE, e a cobrança acontecia por conta própria: o motor
   * debitava a assinatura da organização da análise, sem olhar quem tinha disparado. Um
   * revisor ou o suporte abrindo a análise e clicando em "Reprocessar" gastava crédito
   * DO CLIENTE, sem pedir nada a ninguém.
   *
   * Com a cobrança da diferença de faixa, isso ficou mais caro: a equipe acrescenta um
   * documento para ajudar no atendimento, o processo sobe de faixa, e o cliente é
   * debitado por um trabalho que ele não pediu.
   *
   * O padrão para a equipe interna passou a ser NÃO cobrar — revisão e suporte são
   * trabalho nosso. Cobrar em nome do cliente continua possível, mas exige dizer isso
   * explicitamente (é o caso do suporte reprocessando com documentos que o próprio
   * cliente mandou).
   */
  cobrarCliente?: boolean;
}

export async function processAnalysis(
  analysisId: string,
  opcoes: OpcoesDoProcessamento = {},
): Promise<void> {
  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    /**
     * ⚠️ NÃO traz o texto das páginas: só a contagem.
     *
     * Com o texto cifrado, `include: { pages: true }` alocaria o processo inteiro duas vezes — cifrado e
     * decifrado — numa instância de 512 MB que atende todos os clientes. O texto é lido em lotes por
     * `lerPaginasDoDocumento`. Ver `src/lib/pagina-do-processo.ts`.
     */
    include: { documents: { where: { deletedAt: null }, include: { _count: { select: { pages: true } } } } },
  });
  if (!analysis) throw new Error("Análise não encontrada.");

  /**
   * ⚠️ ANÁLISE ENCERRADA NÃO É PROCESSADA — e esta é a trava que de fato protege o caixa.
   *
   * A rota de processar já recusa CANCELADA e ARQUIVADA, mas a fila é um SEGUNDO caminho até aqui: entre
   * enfileirar e o trabalho ser executado passa tempo, e nessa janela o cliente pode cancelar. O
   * trabalho então rodaria, chamaria a IA (custo real, pago pela Leão Amorim) e debitaria o crédito que
   * o cancelamento acabou de devolver — cobrança que o cliente não reconhece numa análise que ele
   * encerrou. A trava da rota é conveniência; esta é a que vale, porque a cobrança acontece aqui.
   *
   * Sai sem lançar: não é falha, é ordem revogada. Lançar marcaria ERRO_PROCESSAMENTO por cima do
   * CANCELADA, desfazendo o cancelamento e trocando a explicação certa por uma errada.
   */
  if (analysis.status === "CANCELADA" || analysis.status === "ARQUIVADA") {
    console.warn(`[analysis-runner] ${analysisId} está ${analysis.status}: processamento abandonado sem cobrar.`);
    return;
  }

  /**
   * Duas marcas que o `catch` lá embaixo precisa, e que por isso vivem FORA do `try`.
   *
   * O `catch` não tem acesso ao que foi declarado dentro do bloco — foi essa fronteira que
   * produziu os dois defeitos que elas consertam: o estorno relia a assinatura em vez de usar a
   * que cobrou, e o status de saldo insuficiente era sobrescrito por ERRO_PROCESSAMENTO.
   */
  let estaExecucaoCobrou = false;
  let statusPreservado: AnalysisStatus | null = null;

  try {
    await setStatus(analysisId, "VALIDANDO_DOCUMENTOS");

    // Extrai texto dos documentos que ainda não têm páginas processadas.
    await setStatus(analysisId, "EXTRAINDO_INFORMACOES");
    const documentsText: { filename: string; pages: { page: number; text: string }[] }[] = [];
    for (const doc of analysis.documents) {
      if (doc._count.pages > 0) {
        /** Decifra em lotes. Página cifrada que não abrir LANÇA — ver a armadilha 1 do módulo. */
        documentsText.push({ filename: doc.filename, pages: await lerPaginasDoDocumento(doc.id) });
        continue;
      }
      try {
        const buf = await getObject(doc.storageKey);
        const result = await extractText(buf, doc.mimeType);
        if (result.pages.length) {
          await prisma.documentPage.createMany({
            data: result.pages.map((p) => ({ documentId: doc.id, pageNumber: p.page, text: cifrarTextoDaPagina(p.text), legible: p.legible })),
            skipDuplicates: true,
          });
        }
        await prisma.document.update({
          where: { id: doc.id },
          data: {
            status: result.pages.some((p) => p.legible) ? "PROCESSADO" : "ILEGIVEL",
            pageCount: result.pageCount,
            ocrApplied: result.ocrApplied,
            notes: result.note,
          },
        });
        documentsText.push({ filename: doc.filename, pages: result.pages.map((p) => ({ page: p.page, text: p.text })) });
      } catch (e) {
        await prisma.document.update({ where: { id: doc.id }, data: { status: "ILEGIVEL", notes: (e as Error).message } });
      }
      /**
       * Sinal de vida a cada documento.
       *
       * Sem esta marca o relógio só andaria nas trocas de etapa — três em toda a execução
       * —, e um processo com muitos documentos poderia ser tomado por morto no meio da
       * extração: o crédito voltaria ao cliente e a análise seria marcada com erro
       * enquanto ainda estava rodando. Ver src/lib/analise-travada.ts.
       */
      await sinalDeVida(analysisId);
    }

    // -----------------------------------------------------------------------
    // Cobrança. Fica AQUI, depois da extração e antes da chamada de IA, por dois
    // motivos: só agora sabemos o tamanho real do processo (e portanto o custo),
    // e nada foi gasto com o provedor até este ponto — se o saldo não cobrir, o
    // cliente para sem ter consumido nada.
    //
    // `consumirCreditos` é idempotente por análise: reprocessar a mesma análise
    // depois de uma correção técnica não cobra de novo, que é a regra pedida.
    // -----------------------------------------------------------------------
    /**
     * ⚠️ SEM TEXTO LEGÍVEL, NÃO COBRA — e o motivo é que este caminho não tinha a trava que o outro tem.
     *
     * O fluxo automático (`api/analises/automatica`) para com 422 e apaga o rascunho quando nenhuma página
     * é legível, sem cobrar. O preenchimento manual (`/nova-analise/manual`) chega aqui direto: o cliente
     * que subisse só imagem, ou PDF sem camada de texto e sem OCR, tinha o crédito debitado logo abaixo e
     * recebia uma análise sobre nada. Cliente pagante pagando por vazio — encontrado no levantamento de
     * prontidão para vendas de 03/09/2026.
     *
     * A checagem fica ANTES de `consumirCreditos` de propósito: falhar aqui cai no `catch` externo, a
     * análise vai para ERRO_PROCESSAMENTO com esta mensagem, e nenhum crédito foi tocado. Mesmo corte de
     * "tem texto" que a extração usa (`MIN_CHARS_PAGINA`): página só com o carimbo do sistema não conta.
     */
    const totalDePaginas = documentsText.reduce((n, d) => n + d.pages.length, 0);
    const paginasComTexto = documentsText.reduce(
      (n, d) => n + d.pages.filter((p) => p.text.trim().length >= MIN_CHARS_PAGINA).length,
      0,
    );
    if (paginasComTexto === 0) {
      throw new Error(
        `Não foi possível ler o texto dos documentos: ${paginasComTexto} de ${totalDePaginas} páginas têm texto; ` +
          "as demais são imagem digitalizada. Envie o PDF original do sistema processual (com texto " +
          "pesquisável) ou passe o arquivo por OCR. Nenhum crédito foi debitado.",
      );
    }

    const assinatura = await getActiveSubscription(analysis.organizationId);
    const orcamento = await orcamentoDaAnalise(analysisId, assinatura);

    if (orcamento.custo.bloqueado) {
      throw new Error(orcamento.custo.motivo ?? "Processo acima do limite para processamento automático.");
    }

    /**
     * A cobrança é do cliente, então quem NÃO é o cliente não a dispara por acidente.
     * `cobrarCliente` é decidido na rota, pelo papel de quem pediu o processamento.
     */
    const deveCobrar = opcoes.cobrarCliente !== false;

    if (assinatura && deveCobrar) {
      try {
        await consumirCreditos(assinatura.id, analysisId, orcamento.custo.creditos, `Análise: ${analysis.title}`);
        /**
         * ⚠️ Marca que ESTA execução cobrou, e é isso que autoriza o estorno no `catch`.
         *
         * Sem a marca, o estorno devolvia toda cobrança em aberto da análise — e cobrança de
         * execução anterior BEM-SUCEDIDA fica em aberto para sempre, porque só um estorno a
         * fecha. O efeito era dar receita de graça: a equipe reprocessava sem cobrar
         * (`cobrarCliente: false`), a rodada interna dava erro, e o sistema devolvia ao cliente
         * o crédito de uma análise que ele já havia recebido — zerando também `creditsCharged`.
         */
        estaExecucaoCobrou = true;
      } catch (err) {
        if (err instanceof SaldoInsuficienteError) {
          /**
           * ⚠️ Saldo insuficiente NÃO é erro de processamento, e dizer que é manda o cliente
           * para o lugar errado.
           *
           * A linha abaixo gravava AGUARDANDO_INFORMACOES e o `throw` seguinte levava ao
           * `catch` do bloco, que sobrescrevia com ERRO_PROCESSAMENTO. Ou seja: o status
           * correto nunca sobrevivia, e o cliente lia "erro no processamento" quando a verdade
           * era "faltam créditos" — uma pede tentar de novo, a outra pede comprar crédito.
           *
           * A marca faz o `catch` respeitar este status em vez de reescrevê-lo.
           */
          statusPreservado = "AGUARDANDO_INFORMACOES";
          await prisma.analysis.update({ where: { id: analysisId }, data: { status: statusPreservado } });
        }
        throw err;
      }
    }

    if (assinatura && !deveCobrar) {
      /**
       * Registra que a execução saiu sem cobrança, e por quem. O custo de IA continua
       * sendo lançado em `registrarUsoIA` — é despesa nossa, e o painel de custos
       * mostraria lucro que não existe se ela desaparecesse junto com a cobrança.
       */
      await logAudit({
        action: "analysis.processada_sem_cobranca",
        entityType: "Analysis",
        entityId: analysisId,
        metadata: { motivo: "processamento interno: crédito do cliente preservado", creditosQueSeriam: orcamento.custo.creditos },
      });
    }

    // Guarda o tamanho medido, para o extrato e para os indicadores de custo.
    await prisma.analysis.update({
      where: { id: analysisId },
      data: { pageCount: orcamento.paginas, fileBytes: orcamento.bytes },
    });

    // Executa a análise.
    await setStatus(analysisId, "PROCESSANDO");
    const iniciadoEm = Date.now();
    const { data, promptVersionId, model, usage } = await runAnalysis({
      analysis: {
        id: analysis.id,
        title: analysis.title,
        type: analysis.type,
        objective: analysis.objective,
        processNumber: analysis.processNumber,
        court: analysis.court,
        creditor: analysis.creditor,
        debtor: analysis.debtor,
        taxType: analysis.taxType,
        facts: (analysis.facts as Record<string, unknown>) ?? null,
      },
      documentsText,
      // A matéria escolhida pelo cliente está gravada no tipo da análise.
      materia: materiaPorTipo(analysis.type)?.slug ?? null,
    });

    // Persiste linha do tempo.
    await prisma.timelineEvent.deleteMany({ where: { analysisId } });
    if (data.timeline.length) {
      await prisma.timelineEvent.createMany({
        data: data.timeline.map((t) => ({
          analysisId,
          eventDate: parseIso(t.eventDate),
          dateText: t.dateText ?? undefined,
          type: (isTimelineType(t.type) ? t.type : "SEM_EFEITO_DEFINIDO") as never,
          nature: (isNature(t.nature) ? t.nature : "HIPOTESE") as never,
          description: t.description,
          legalEffect: t.legalEffect ?? undefined,
          sourcePage: t.sourcePage ?? undefined,
        })),
      });
    }

    // Persiste relatório (seções 1-3), versionado.
    const lastReport = await prisma.report.findFirst({ where: { analysisId }, orderBy: { version: "desc" } });
    const reportVersion = (lastReport?.version ?? 0) + 1;
    await prisma.report.create({
      data: {
        analysisId,
        version: reportVersion,
        confidence: data.confidence as never,
        content: data as unknown as object,
        markdown: buildReportMarkdown(analysis.title, data),
        aiModel: model,
      },
    });

    // Persiste a peça, versionada.
    //
    // Na análise dirigida a regra é estrita: só há peça com resultado POSITIVO.
    // A checagem fica aqui, no servidor, e não na interface — se a IA devolver
    // uma petição junto de um resultado negativo, ela não chega ao banco.
    const dirigida = data.dirigida;
    const podeGerarPeca = dirigida
      ? dirigida.resultado === "positivo" && dirigida.peticao.trim().length > 0
      : data.epe.titulo !== "NAO_RECOMENDADA";

    if (podeGerarPeca) {
      const lastPetition = await prisma.petition.findFirst({
        where: { analysisId, type: "EXCECAO_PRE_EXECUTIVIDADE" },
        orderBy: { version: "desc" },
      });
      const titulo = dirigida?.medidaProcessualSugerida || "Exceção de Pré-Executividade";
      await prisma.petition.create({
        data: {
          analysisId,
          type: "EXCECAO_PRE_EXECUTIVIDADE",
          version: (lastPetition?.version ?? 0) + 1,
          title: `${titulo}: ${analysis.title}`,
          markdown: data.epe.markdown,
          pendingFields: data.documentosFaltantes.length ? { faltantes: data.documentosFaltantes, condicionada: data.epe.titulo === "CONDICIONADA" } : undefined,
          aiModel: model,
        },
      });
    } else {
      // Reprocessamento que deixou de ser positivo: a peça anterior não pode
      // continuar visível sugerindo uma tese que a análise atual não sustenta.
      await prisma.petition.deleteMany({ where: { analysisId } });
    }

    // Atualiza confiança e conclui.
    await prisma.analysis.update({
      where: { id: analysisId },
      data: {
        confidence: data.confidence as never,
        aiModel: model,
        promptVersionId: promptVersionId ?? undefined,
        status: "AGUARDANDO_REVISAO",
        completedAt: new Date(),
      },
    });

    // Abre revisão jurídica pendente.
    await prisma.legalReview.upsert({ where: { analysisId }, create: { analysisId, status: "PENDENTE" }, update: {} });

    // Consumo do plano (histórico legado, mantido para os relatórios existentes).
    if (assinatura) await recordAnalysisConsumption(assinatura.id, analysisId, usage);

    // Custo de API — base dos indicadores administrativos. Nunca exposto ao cliente.
    await registrarUsoIA({
      analysisId,
      organizationId: analysis.organizationId,
      subscriptionId: assinatura?.id ?? null,
      userId: analysis.ownerId,
      planSlug: assinatura ? (await prisma.plan.findUnique({ where: { id: assinatura.planId } }))?.slug ?? null : null,
      provider: data.mode === "ia" ? "openai" : "heuristica",
      model: model ?? "desconhecido",
      inputTokens: usage?.input ?? 0,
      outputTokens: usage?.output ?? 0,
      durationMs: Date.now() - iniciadoEm,
      pageCount: orcamento.paginas,
      fileBytes: orcamento.bytes,
      creditsCharged: orcamento.custo.creditos,
      reprocess: analysis.reprocessCount > 0,
    });

    await logAudit({ action: "analysis.processed", entityType: "Analysis", entityId: analysisId, metadata: { mode: data.mode, confidence: data.confidence, tese: data.tesePrincipal, creditos: orcamento.custo.creditos } });
  } catch (err) {
    /**
     * O status de parada respeita o que já foi decidido com mais informação.
     *
     * Saldo insuficiente grava AGUARDANDO_INFORMACOES antes de relançar; sobrescrever aqui
     * apagava essa verdade e mandava o cliente tentar de novo em vez de comprar crédito.
     */
    await setStatus(analysisId, statusPreservado ?? "ERRO_PROCESSAMENTO");

    /**
     * Estorno automático: o cliente não paga por falha nossa.
     *
     * ── Dois furos consertados aqui, os dois silenciosos ────────────────────────
     * 1. A assinatura vinha de `getActiveSubscription(org)` — a ATIVA AGORA, não a que cobrou.
     *    Análise longa que atravessa a virada do ciclo, cliente que cancela, admin que suspende,
     *    conta que vai a ESTORNADA: em qualquer desses a busca devolvia nulo, o estorno nem era
     *    tentado, e o cliente perdia o crédito de uma análise que não recebeu. Agora a
     *    assinatura vem da RAZÃO, que é onde o vínculo de verdade está gravado.
     *
     * 2. A falha do estorno era engolida por um `.catch(() => null)`. Crédito não devolvido, sem
     *    registro, sem aviso, sem jeito de encontrar depois. Num sistema em que o crédito É o
     *    produto, isso é dinheiro do cliente desaparecendo sem rastro.
     *
     * Chamar é seguro em qualquer caso: sem cobrança não faz nada, e estornar duas vezes não
     * credita duas vezes.
     */
    try {
      /**
       * ⚠️ Só devolve se ESTA execução cobrou.
       *
       * Cobrança de execução anterior bem-sucedida fica em aberto para sempre — só um estorno a
       * fecha —, então devolver "tudo o que está em aberto" dava receita de graça: reprocessamento
       * interno (`cobrarCliente: false`, nada debitado nesta rodada) que terminasse em erro
       * devolvia ao cliente o crédito de uma análise que ele já havia recebido.
       */
      const estorno = estaExecucaoCobrou
        ? await estornarCreditosDaAnalise(analysisId, "erro técnico no processamento")
        : { estornados: 0, jaEstornado: false, semCobranca: true };
      if (estorno.estornados > 0) {
        await logAudit({
          action: "credits.refunded",
          entityType: "Analysis",
          entityId: analysisId,
          metadata: { creditos: estorno.estornados, motivo: (err as Error).message },
        });
      }
    } catch (falhaDoEstorno) {
      /**
       * Alerta, e não só log: aqui o cliente pagou por uma análise que falhou e NÃO recebeu o
       * crédito de volta. Não se conserta sozinho, e sem aviso ninguém descobre — a análise
       * aparece como erro, o que é esperado, e o crédito faltando não aparece em lugar nenhum.
       */
      await alertarOperacao({
        tipo: "credito_nao_estornado_apos_falha",
        assunto: "Análise falhou e o crédito NÃO foi devolvido",
        linhas: [
          `Análise: ${analysisId}.`,
          `Falha do processamento: ${(err as Error).message}`,
          `Falha do estorno: ${(falhaDoEstorno as Error).message}`,
          "O cliente pagou por uma análise que não recebeu, e o crédito continua debitado.",
        ],
        acao:
          "Devolva o crédito pela tela administrativa de análises (ação \"Estornar crédito\"). Ela é" +
          " idempotente: se o estorno tiver acontecido no meio do caminho, não devolve duas vezes.",
        metadata: { source: "analysis-runner", analysisId, organizationId: analysis.organizationId },
      });
    }

    await registrarUsoIA({
      analysisId,
      organizationId: analysis.organizationId,
      userId: analysis.ownerId,
      provider: "desconhecido",
      model: "erro",
      errored: true,
      errorMessage: (err as Error).message.slice(0, 500),
    });

    await logAudit({ action: "analysis.error", entityType: "Analysis", entityId: analysisId, metadata: { message: (err as Error).message } });
    throw err;
  }
}

function parseIso(v?: string | null): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

const TIMELINE_TYPES = new Set([
  "CONSTITUICAO_CREDITO", "INSCRICAO_DIVIDA_ATIVA", "AJUIZAMENTO", "DESPACHO_CITATORIO", "CITACAO",
  "PARCELAMENTO", "SUSPENSAO", "ARQUIVAMENTO", "PENHORA", "GARANTIA", "MANIFESTACAO", "DECISAO",
  "DILIGENCIA", "POSSIVEL_INTERRUPTIVO", "POSSIVEL_SUSPENSIVO", "SEM_EFEITO_DEFINIDO",
]);
const NATURES = new Set(["FATO_CONFIRMADO", "INTERPRETACAO", "HIPOTESE", "PENDENTE"]);
function isTimelineType(v: string): boolean { return TIMELINE_TYPES.has(v); }
function isNature(v: string): boolean { return NATURES.has(v); }
