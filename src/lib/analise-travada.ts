import { prisma } from "./db";
import { MINUTOS_SEM_SINAL_DE_VIDA, STATUS_EM_EXECUCAO } from "./analise-execucao";
import { estornarCreditosDaAnalise } from "./credits";
import { logAudit } from "./audit";
import { alertarOperacao } from "./alerta-operacional";
import type { AnalysisStatus } from "@prisma/client";

/**
 * Análise que ficou presa em processamento — e o crédito que ficou preso com ela.
 *
 * ── O defeito ─────────────────────────────────────────────────────────────────
 * O crédito é debitado ANTES da chamada de IA, de propósito: é o único momento em que
 * dá para recusar por saldo sem ter gastado nada com o provedor. E o estorno automático
 * existe, é correto e está testado — mas mora no `catch` de `processAnalysis`.
 *
 * `catch` só roda quando o código lança. Ele NÃO roda quando o processo morre:
 *
 *  - deploy no Render no meio de um processamento (acontece a cada `git push`);
 *  - `maxDuration = 300` da rota: no modo síncrono, execução mais longa que cinco
 *    minutos é cortada pela plataforma — e OCR de processo grande chega perto disso;
 *  - falta de memória, reinício do contêiner, worker derrubado.
 *
 * O que sobrava: status parado em EXTRAINDO_INFORMACOES ou PROCESSANDO, crédito
 * debitado, nenhum estorno, nenhum aviso — e a análise IMPOSSÍVEL de retomar, porque a
 * rota de processar recusa com 409 enquanto o status é de processamento. O cliente
 * pagava, não recebia nada, via "processando" para sempre e não tinha nem o botão de
 * tentar de novo. Nada em tela nenhuma dizia que aquilo existia.
 *
 * ── Como se conserta ──────────────────────────────────────────────────────────
 * Duas frentes, porque uma só não basta:
 *
 * 1. SOB DEMANDA (`destravarSeAbandonada`): a própria rota de processar destrava antes
 *    de recusar por 409. O cliente que aperta "Reprocessar" resolve na hora, em vez de
 *    esperar a madrugada.
 *
 * 2. VARREDURA (`destravarAnalisesAbandonadas`): na manutenção diária, para as análises
 *    que ninguém abriu. Sem ela, o crédito de quem desistiu e foi embora fica debitado
 *    para sempre.
 */

/**
 * ⚠️ As duas constantes MUDARAM DE CASA e são reexportadas daqui.
 *
 * Elas moravam neste arquivo, que importa o cliente do banco, as variáveis de ambiente, a auditoria e o
 * envio de e-mail. Um componente de NAVEGADOR (`analysis-actions.tsx`) importava `STATUS_EM_EXECUCAO`
 * daqui — e o empacotador, que não recorta, levava a cadeia inteira para o JavaScript do navegador.
 * Confirmado no pacote de produção: `PrismaClient` e o objeto de variáveis de ambiente chegavam lá.
 *
 * A reexportação existe para não quebrar os arquivos de servidor que já as importam deste módulo. Quem
 * roda no navegador deve importar de `@/lib/analise-execucao`. Ver o cabeçalho daquele arquivo.
 */
export { STATUS_EM_EXECUCAO, MINUTOS_SEM_SINAL_DE_VIDA } from "./analise-execucao";


export interface ResultadoDestrave {
  destravada: boolean;
  creditosEstornados: number;
}

/** Marca de vida durante o processamento, para a varredura não matar execução viva. */
export async function sinalDeVida(analysisId: string, status?: AnalysisStatus): Promise<void> {
  await prisma.analysis.update({
    where: { id: analysisId },
    data: { heartbeatAt: new Date(), ...(status ? { status } : {}) },
  });
}

function limite(agora: Date): Date {
  return new Date(agora.getTime() - MINUTOS_SEM_SINAL_DE_VIDA * 60_000);
}

/**
 * "Sem sinal de vida há tempo demais", em filtro do Prisma.
 *
 * O recuo para `updatedAt` cobre as análises que já estavam presas ANTES deste campo
 * existir: sem ele, o crédito delas ficaria debitado para sempre — exatamente o defeito
 * que a rotina veio consertar, preservado para quem já foi atingido por ele.
 */
function semSinalDeVida(agora: Date) {
  const corte = limite(agora);
  return {
    OR: [{ heartbeatAt: { lt: corte } }, { heartbeatAt: null, updatedAt: { lt: corte } }],
  };
}

/** Momento do último sinal, para mensagem e registro. */
export function ultimoSinal(analise: { heartbeatAt: Date | null; updatedAt: Date }): Date {
  return analise.heartbeatAt ?? analise.updatedAt;
}

/**
 * Encerra uma execução abandonada: devolve o crédito e libera a análise para nova
 * tentativa. Idempotente — o estorno não devolve duas vezes, e a análise já liberada
 * não é encontrada pelo filtro.
 */
async function encerrarAbandonada(
  analise: { id: string; organizationId: string; status: AnalysisStatus; updatedAt: Date; heartbeatAt: Date | null },
  motivo: string,
): Promise<ResultadoDestrave> {
  await prisma.analysis.update({
    where: { id: analise.id },
    data: { status: "ERRO_PROCESSAMENTO" },
  });

  /**
   * ⚠️ A ASSINATURA VEM DA RAZÃO, NÃO DA ORGANIZAÇÃO — e a versão anterior deixava o cliente sem o
   * crédito, em silêncio, exatamente no caso que mais dói.
   *
   * Era `getActiveSubscription(organizationId)`, que devolve NULO quando a assinatura não concede acesso
   * agora: SUSPENSA, VENCIDA, INADIMPLENTE fora da tolerância, ESTORNADA, ou CANCELADA fora do período
   * pago. Com nulo, o `if (sub)` pulava o estorno inteiro e a auditoria gravava `creditosEstornados: 0`
   * — indistinguível de "não havia nada a devolver". O alerta operacional somava zero e nada acusava.
   *
   * Quem isso atinge: o cliente com pagamento em atraso cujo processamento morreu. Ele pagou pelo
   * crédito, não recebeu a análise, não recebeu o crédito de volta — e é justamente quem vai conferir o
   * saldo com lupa quando regularizar.
   *
   * `estornarCreditosDaAnalise` resolve a assinatura pela linha de CONSUMO da razão: a que REALMENTE
   * cobrou, que sobrevive a qualquer mudança de estado da assinatura. O próprio `credits.ts` documenta
   * este furo como consertado, e o motor já usava a versão certa; só a varredura tinha ficado atrás.
   *
   * O estorno também deixa `creditsCharged` no líquido, e isso tem um efeito colateral desejado: a nova
   * tentativa deixa de contar como REPROCESSAMENTO. Queda de servidor não é o cliente pedindo
   * reexecução, e não pode gastar o limite de reprocessos dele.
   */
  let creditosEstornados = 0;
  let semCobranca = false;
  let falhaDoEstorno: string | null = null;
  try {
    const estorno = await estornarCreditosDaAnalise(analise.id, motivo);
    creditosEstornados = estorno.estornados;
    semCobranca = estorno.semCobranca;
  } catch (err) {
    /**
     * ⚠️ Falha do estorno ALERTA, e antes era engolida por `.catch(() => null)`.
     *
     * Aqui o cliente pagou por uma análise que não recebeu E o crédito não voltou. Não se conserta
     * sozinho e ninguém descobre: a análise aparece como erro, o que é esperado, e o crédito faltando
     * não aparece em lugar nenhum. É o mesmo alerta que o motor já dispara no caminho dele.
     */
    falhaDoEstorno = (err as Error).message;
    await alertarOperacao({
      tipo: "credito_nao_estornado_apos_falha",
      assunto: "Execução abandonada: o crédito NÃO foi devolvido",
      linhas: [
        `Análise: ${analise.id}.`,
        `Motivo do destrave: ${motivo}`,
        `Falha do estorno: ${falhaDoEstorno}`,
        "O cliente pagou por uma análise que não recebeu, e o crédito continua debitado.",
      ],
      acao: "Devolva o crédito à mão no painel (Assinaturas → movimentação de créditos) e confira a causa da falha.",
      metadata: { analiseId: analise.id, erro: falhaDoEstorno },
    });
  }

  await logAudit({
    action: "analysis.execucao_abandonada",
    entityType: "Analysis",
    entityId: analise.id,
    metadata: {
      statusAnterior: analise.status,
      ultimoSinalDeVida: ultimoSinal(analise),
      creditosEstornados,
      /**
       * Zero deixa de ser ambíguo no registro: `semCobranca` diz que não havia o que devolver, e
       * `falhaDoEstorno` diz que havia e não deu. Sem os dois, "0 devolvido" cobria os dois casos —
       * um normal e o outro grave — e ninguém conseguia distinguir depois.
       */
      semCobranca,
      ...(falhaDoEstorno ? { falhaDoEstorno } : {}),
      motivo,
    },
  });

  return { destravada: true, creditosEstornados };
}

/**
 * A análise está presa numa execução que morreu? Então destrava.
 *
 * Chamada pela rota de processar ANTES da recusa por "já está em processamento": é o
 * que transforma um beco sem saída em um botão que funciona.
 */
export async function destravarSeAbandonada(
  analysisId: string,
  agora: Date = new Date(),
): Promise<ResultadoDestrave> {
  const analise = await prisma.analysis.findFirst({
    where: { id: analysisId, status: { in: STATUS_EM_EXECUCAO }, ...semSinalDeVida(agora) },
    select: { id: true, organizationId: true, status: true, updatedAt: true, heartbeatAt: true },
  });
  if (!analise) return { destravada: false, creditosEstornados: 0 };

  return encerrarAbandonada(
    analise,
    `processamento interrompido sem conclusão (sem sinal de vida por mais de ${MINUTOS_SEM_SINAL_DE_VIDA} minutos)`,
  );
}

export interface ResultadoVarredura {
  destravadas: number;
  creditosEstornados: number;
  ids: string[];
}

/**
 * Varredura das execuções abandonadas, para a manutenção diária.
 *
 * Cuida de quem não voltou para a tela: sem isso, o crédito de quem viu "processando",
 * desistiu e foi embora fica debitado para sempre — e nós nunca saberíamos que aconteceu.
 */
export async function destravarAnalisesAbandonadas(agora: Date = new Date()): Promise<ResultadoVarredura> {
  const travadas = await prisma.analysis.findMany({
    where: { status: { in: STATUS_EM_EXECUCAO }, ...semSinalDeVida(agora) },
    select: { id: true, organizationId: true, status: true, updatedAt: true, heartbeatAt: true, title: true },
    orderBy: { updatedAt: "asc" },
  });

  let creditosEstornados = 0;
  const ids: string[] = [];
  for (const analise of travadas) {
    try {
      const r = await encerrarAbandonada(analise, "processamento interrompido (varredura de manutenção)");
      creditosEstornados += r.creditosEstornados;
      ids.push(analise.id);
    } catch (err) {
      // Uma análise problemática não pode interromper a varredura: as outras ficariam
      // com o crédito preso por causa de um caso isolado.
      console.error(`[analise-travada] ${analise.id} não pôde ser destravada:`, (err as Error).message);
    }
  }

  /**
   * O alerta não é sobre o crédito — esse já foi devolvido. É sobre a CAUSA: execução
   * cortada pela metade, em quantidade, significa que a plataforma está matando o
   * processamento (modo síncrono estourando o tempo da requisição, deploy no meio,
   * memória insuficiente). Isso não se conserta sozinho e nenhum cliente vai reclamar
   * do que não vê.
   */
  if (ids.length > 0) {
    await alertarOperacao({
      tipo: "analise_execucao_abandonada",
      assunto: `${ids.length} análise(s) tiveram o processamento interrompido`,
      linhas: [
        `Análises destravadas: ${ids.length}.`,
        `Créditos devolvidos aos clientes: ${creditosEstornados}.`,
        `Mais antiga sem sinal de vida desde ${travadas[0] ? ultimoSinal(travadas[0]).toLocaleString("pt-BR") : "-"}.`,
        "Cada uma delas ficou com o crédito debitado e sem resultado até esta varredura.",
      ],
      acao:
        "Se isto repetir, o processamento está sendo cortado: confira o tempo limite da requisição" +
        " (QUEUE_DRIVER=sync processa dentro da requisição), a memória do serviço e se houve deploy no horário.",
      metadata: { analises: ids.slice(0, 20), creditosEstornados },
    });
  }

  return { destravadas: ids.length, creditosEstornados, ids };
}
