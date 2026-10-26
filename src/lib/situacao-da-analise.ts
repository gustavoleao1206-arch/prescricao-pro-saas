import { prisma } from "./db";
import { estornarCreditosDaAnalise } from "./credits";
import { logAudit } from "./audit";
import { MINUTOS_SEM_SINAL_DE_VIDA, STATUS_EM_EXECUCAO, ultimoSinal } from "./analise-travada";
import type { AnalysisStatus, Role } from "@prisma/client";

/**
 * Cancelar, arquivar e desarquivar uma análise — a regra num lugar só.
 *
 * ── O defeito que isto conserta ───────────────────────────────────────────────
 * `CANCELADA`, `ARQUIVADA` e `EM_REVISAO` existiam no banco, tinham selo colorido em
 * `components/ui/badge.tsx` e eram descritos nos manuais PUBLICADOS do produto — e nenhum caminho do
 * sistema escrevia nenhum deles. Uma busca por `status: "CANCELADA"` numa análise não achava nada em
 * lugar nenhum. Existia uma rota que aceitaria os valores (`PATCH /api/analises/[id]`), mas ela não
 * tinha um único chamador, não validava transição alguma e não encostava em crédito.
 *
 * O efeito prático era um beco sem saída no caminho do dinheiro: o cliente com uma análise que deu
 * ERRO_PROCESSAMENTO e já reprocessada três vezes tinha exatamente uma opção — EXCLUIR, que apaga os
 * documentos e não devolve nada. Ou seja, a única saída oferecida a quem pagou e não recebeu era
 * destruir a prova de que pagou.
 *
 * ── Por que as três ações moram juntas ────────────────────────────────────────
 * Porque a pergunta "de qual status para qual status, e o que acontece com o crédito" tem de ter uma
 * resposta só. Com a regra espalhada entre a tela do cliente, a tela do administrador e as rotas, elas
 * divergem — e divergir aqui significa a tela oferecer um botão que o servidor recusa, ou pior, uma
 * ação devolver crédito num lugar e não devolver no outro.
 *
 * ── A regra do crédito, que é a decisão que importa ───────────────────────────
 * Cancelar devolve o crédito **quando nada foi entregue**, isto é, quando não existe relatório. É a
 * situação do cliente que pagou, viu erro e não tem resultado nenhum: sem a devolução, cancelar seria
 * um jeito de ele perder o dinheiro por iniciativa própria.
 *
 * Havendo relatório, cancelar é decisão de arquivo e não mexe em dinheiro: a apuração foi feita, o
 * custo com o provedor de IA foi pago pela Leão Amorim, e devolver ali transformaria "peço a análise,
 * leio o relatório e cancelo" em análise de graça.
 *
 * Arquivar e desarquivar NUNCA tocam em crédito — são organização de tela.
 */

export type AcaoDeSituacao = "cancelar" | "arquivar" | "desarquivar";

/** Situações que somem da lista por padrão: encerradas por decisão de alguém. */
export const STATUS_ENCERRADOS: AnalysisStatus[] = ["CANCELADA", "ARQUIVADA"];

/**
 * Agrupamentos de status para filtrar as listas.
 *
 * ── Por que existem, e por que num lugar só ───────────────────────────────────
 * Nenhuma das duas listas de análise tinha filtro. A do cliente carregava TODAS as análises da
 * organização sem limite nenhum, e a do administrador trazia as 200 mais recentes de todos os clientes
 * juntos — o que significa que, passando de 200, as mais antigas simplesmente não existiam para o
 * atendimento, sem nada em tela dizendo que a lista estava truncada.
 *
 * Sem filtro, arquivar também não teria efeito nenhum: a análise arquivada continuaria na mesma lista,
 * no mesmo lugar. Arquivar só significa algo se existir uma lista de onde ela sai.
 *
 * Os grupos ficam aqui, com as ações, porque as duas telas precisam concordar sobre o que é "ativa" —
 * e é essa a definição que faz o arquivamento funcionar.
 */
export type GrupoDeSituacao =
  | "ativas"
  | "atencao"
  | "processando"
  | "revisao"
  | "concluidas"
  | "canceladas"
  | "arquivadas"
  | "todas";

/** `status: null` significa "sem filtro". */
export const GRUPOS_DE_SITUACAO: Record<GrupoDeSituacao, { rotulo: string; status: AnalysisStatus[] | null }> = {
  ativas: {
    rotulo: "Ativas",
    status: [
      "RASCUNHO",
      "DOCUMENTOS_ENVIADOS",
      "VALIDANDO_DOCUMENTOS",
      "EXTRAINDO_INFORMACOES",
      "PROCESSANDO",
      "AGUARDANDO_INFORMACOES",
      "AGUARDANDO_REVISAO",
      "EM_REVISAO",
      "CONCLUIDA",
      "ERRO_PROCESSAMENTO",
    ],
  },
  /** O grupo que o atendimento abre primeiro: é onde estão os clientes esperando algo. */
  atencao: { rotulo: "Precisam de atenção", status: ["ERRO_PROCESSAMENTO", "AGUARDANDO_INFORMACOES"] },
  processando: { rotulo: "Em processamento", status: STATUS_EM_EXECUCAO },
  revisao: { rotulo: "Aguardando revisão", status: ["AGUARDANDO_REVISAO", "EM_REVISAO"] },
  concluidas: { rotulo: "Concluídas", status: ["CONCLUIDA"] },
  canceladas: { rotulo: "Canceladas", status: ["CANCELADA"] },
  arquivadas: { rotulo: "Arquivadas", status: ["ARQUIVADA"] },
  todas: { rotulo: "Todas", status: null },
};

/**
 * O grupo pedido na URL, com queda para o padrão.
 *
 * `searchParams` é entrada de quem navega: um valor desconhecido não pode virar filtro vazio (que
 * mostraria uma lista sem nada e pareceria "não há análises") nem estourar.
 */
export function grupoDaUrl(bruto: string | undefined, padrao: GrupoDeSituacao = "ativas"): GrupoDeSituacao {
  /**
   * ⚠️ `hasOwnProperty`, e NÃO o operador `in`.
   *
   * `in` percorre a cadeia de protótipos, então `"constructor" in GRUPOS_DE_SITUACAO` é verdadeiro — e
   * `?situacao=constructor` passava por válido. O que vem depois é `GRUPOS_DE_SITUACAO["constructor"]`,
   * que é a função Object: `.rotulo` fica indefinido, a tela chama `.toLowerCase()` nele e a página
   * responde 500. O mesmo com `toString`, `valueOf`, `__proto__`.
   *
   * Ninguém digita isso por acidente, mas é uma URL pública derrubando a tela de trabalho do
   * atendimento — e o conserto é uma linha.
   */
  return bruto && Object.prototype.hasOwnProperty.call(GRUPOS_DE_SITUACAO, bruto)
    ? (bruto as GrupoDeSituacao)
    : padrao;
}

/**
 * O que cada ação exige do status atual.
 *
 * Cancelar não aparece para CONCLUIDA de propósito: análise entregue se arquiva, não se cancela.
 * Cancelar uma entrega mudaria o selo para "Cancelada" numa análise que o cliente recebeu, usou e
 * talvez tenha protocolado — e o histórico dele passaria a mentir.
 */
const ORIGENS: Record<AcaoDeSituacao, AnalysisStatus[]> = {
  cancelar: [
    "RASCUNHO",
    "DOCUMENTOS_ENVIADOS",
    "AGUARDANDO_INFORMACOES",
    "AGUARDANDO_REVISAO",
    "EM_REVISAO",
    "ERRO_PROCESSAMENTO",
    /** Em execução também — mas só se a execução tiver MORRIDO. Ver `podeExecutar`. */
    ...STATUS_EM_EXECUCAO,
  ],
  arquivar: ["CONCLUIDA", "CANCELADA"],
  desarquivar: ["ARQUIVADA"],
};

export type RecusaDeSituacao = "status_incompativel" | "execucao_viva" | "sem_permissao";

/** Análise no mínimo necessário para decidir. Serve tanto ao servidor quanto à montagem da tela. */
export interface AnaliseParaSituacao {
  id: string;
  status: AnalysisStatus;
  heartbeatAt: Date | null;
  updatedAt: Date;
  completedAt: Date | null;
}

/**
 * A ação é possível nesta análise agora?
 *
 * Existe para a TELA e para o SERVIDOR usarem a mesma resposta. Botão que aparece e é recusado ensina
 * o cliente a desconfiar da tela; botão que não aparece quando funcionaria esconde a saída de quem
 * está tentando se resolver. Os dois erros vêm de a decisão morar em dois lugares.
 */
export function podeExecutar(
  acao: AcaoDeSituacao,
  analise: AnaliseParaSituacao,
  agora: Date = new Date(),
): { pode: boolean; recusa?: RecusaDeSituacao } {
  if (!ORIGENS[acao].includes(analise.status)) return { pode: false, recusa: "status_incompativel" };

  /**
   * ⚠️ Execução VIVA não é cancelada, e a distinção não é preciosismo.
   *
   * O motor está rodando noutro lugar: ele vai gravar o status dele quando terminar e sobrescrever o
   * CANCELADA — a análise "descancelaria" sozinha alguns minutos depois, e o cliente veria o próprio
   * cancelamento ser desfeito sem explicação. Pior: a análise cancelada continuaria consumindo a
   * chamada de IA que já estava paga.
   *
   * Execução MORTA (sem sinal de vida) é o caso oposto e é justamente onde cancelar tem valor: não há
   * ninguém para sobrescrever nada, e o crédito está preso. O critério é o MESMO da varredura de
   * manutenção (`src/lib/analise-travada.ts`), para tela e rotina nunca discordarem do que está travado.
   */
  if (STATUS_EM_EXECUCAO.includes(analise.status)) {
    const morta = ultimoSinal(analise).getTime() < agora.getTime() - MINUTOS_SEM_SINAL_DE_VIDA * 60_000;
    if (!morta) return { pode: false, recusa: "execucao_viva" };
  }

  return { pode: true };
}

/** Texto de cada recusa. Um lugar só, para a rota e a tela dizerem a mesma coisa. */
export const MENSAGEM_DE_RECUSA: Record<RecusaDeSituacao, string> = {
  status_incompativel: "Esta análise não está numa situação em que essa ação faça sentido.",
  execucao_viva:
    "Esta análise está sendo processada agora. Aguarde o fim do processamento — cancelar no meio faria o" +
    " resultado sobrescrever o cancelamento minutos depois.",
  sem_permissao: "Você não tem permissão para alterar esta análise.",
};

/**
 * Para onde a análise volta ao desarquivar.
 *
 * ⚠️ LÊ A AUDITORIA DO ARQUIVAMENTO. A primeira versão DEDUZIA de `completedAt`, e estava errada.
 *
 * O raciocínio era: só CONCLUIDA e CANCELADA podem ser arquivadas, e `completedAt` marca a conclusão —
 * logo, data preenchida significa que veio de CONCLUIDA. A premissa é falsa: `analysis-runner.ts` grava
 * `completedAt` junto com AGUARDANDO_REVISAO, ao FIM DO PROCESSAMENTO, não na conclusão. E ninguém
 * limpa o campo depois — a revisão devolvida (`revisao/route.ts`) derruba o status para
 * AGUARDANDO_INFORMACOES e deixa a data lá.
 *
 * O caminho do estrago, todo do lado do cliente, sem administrador nenhum:
 *
 *   a análise processa e vai a AGUARDANDO_REVISAO (com `completedAt` gravado) → o cliente CANCELA →
 *   arquiva → desarquiva → e ela volta com o selo verde de CONCLUÍDA.
 *
 * Ou seja: a análise que ele cancelou reaparecia como entregue, com a revisão jurídica ainda pendente,
 * de volta na lista de ativas. Num produto cuja saída vai para os autos, o status do registro é prova
 * de diligência — e ele passaria a afirmar uma entrega que não houve. Pior, CONCLUIDA não é situação
 * encerrada: o botão Reprocessar voltava, furando a trava de cobrança. E não havia volta, porque
 * cancelar não é permitido a partir de CONCLUIDA.
 *
 * A auditoria de `analysis.arquivar` já grava `statusAnterior` — o fato exato, escrito por quem
 * arquivou. Sem coluna nova, sem dedução.
 *
 * O padrão da queda é CANCELADA de propósito: se o registro faltar (`logAudit` é best-effort e engole
 * o próprio erro, e análises arquivadas antes desta mudança não têm o registro), errar para "cancelada"
 * é recuperável — o cliente reprocessa. Errar para "concluída" afirma uma entrega, e não tem volta.
 */
async function destinoDoDesarquivamento(analiseId: string): Promise<AnalysisStatus> {
  const registro = await prisma.auditLog.findFirst({
    where: { action: "analysis.arquivar", entityType: "Analysis", entityId: analiseId },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const meta = (registro?.metadata ?? {}) as { statusAnterior?: unknown };
  return meta.statusAnterior === "CONCLUIDA" ? "CONCLUIDA" : "CANCELADA";
}

export interface ResultadoDaSituacao {
  statusAnterior: AnalysisStatus;
  status: AnalysisStatus;
  /** Créditos devolvidos por esta ação. Zero é o normal — só cancelar sem entrega devolve. */
  creditosDevolvidos: number;
  /** Havia relatório? É o que decide o crédito, e a tela explica melhor sabendo. */
  tinhaRelatorio: boolean;
  /**
   * O crédito já havia sido devolvido ANTES desta ação.
   *
   * ⚠️ Distinção necessária, e a falta dela fazia a tela mentir. Acontece de verdade: a varredura de
   * manutenção já estorna a análise cujo processamento morreu (`analise-travada.ts`). Quando o cliente
   * cancela depois disso, `estornarCreditos` responde `jaEstornado` e devolve zero — e sem separar os
   * dois casos a mensagem dizia "não havia crédito debitado nesta análise", que é falso: havia, e ele
   * já está de volta no saldo. A pessoa concluiria que pagou e não recebeu nada de volta.
   */
  creditoJaDevolvido: boolean;
  /**
   * Outra requisição mudou o status entre a leitura e a gravação — nada foi aplicado.
   *
   * Existe porque a gravação é compare-and-set: sem devolver isto, quem chama diria "pronto" para uma
   * ação que não aconteceu, e a pessoa acreditaria ter cancelado uma análise que segue rodando.
   */
  conflito?: boolean;
}

/**
 * Aplica a ação: muda o status, devolve crédito quando é devido e registra em auditoria.
 *
 * Presume que `podeExecutar` já disse sim — quem chama tem de checar, porque a mensagem de recusa
 * pertence à camada que fala com a pessoa.
 */
export async function aplicarSituacao(
  acao: AcaoDeSituacao,
  analise: AnaliseParaSituacao,
  ator: { id: string; role: Role },
): Promise<ResultadoDaSituacao> {
  const statusAnterior = analise.status;
  const tinhaRelatorio = (await prisma.report.count({ where: { analysisId: analise.id } })) > 0;

  let creditosDevolvidos = 0;
  let creditoJaDevolvido = false;
  /**
   * ⚠️ O ESTORNO VEM ANTES DA MUDANÇA DE STATUS, e a ordem é deliberada.
   *
   * Se o status fosse gravado primeiro e o estorno falhasse, sobraria uma análise CANCELADA com o
   * crédito retido — e nenhum caminho para devolvê-lo, porque cancelar de novo é recusado por
   * "status_incompativel". O cliente perderia o crédito por ter clicado no botão que devia devolvê-lo.
   *
   * Na ordem inversa, uma falha entre os dois passos deixa o crédito de volta e a análise ainda
   * cancelável: a pessoa clica outra vez e resolve. E não devolve em dobro, porque `estornarCreditos`
   * conta CONSUMO contra ESTORNO — a segunda chamada responde `jaEstornado`.
   */
  if (acao === "cancelar" && !tinhaRelatorio) {
    const estorno = await estornarCreditosDaAnalise(
      analise.id,
      `análise cancelada sem entrega (status anterior: ${statusAnterior})`,
    );
    creditosDevolvidos = estorno.estornados;
    creditoJaDevolvido = estorno.jaEstornado;
  }

  const status: AnalysisStatus =
    acao === "cancelar"
      ? "CANCELADA"
      : acao === "arquivar"
        ? "ARQUIVADA"
        : await destinoDoDesarquivamento(analise.id);

  /**
   * ⚠️ A GRAVAÇÃO É CONDICIONAL AO STATUS LIDO — compare-and-set, não `update` cego.
   *
   * `analise` foi lida antes (na rota, ou na montagem da tela), e entre a leitura e esta escrita cabe
   * outra requisição. O caso que custa dinheiro: o cliente clica em "Cancelar" e em "Reprocessar" quase
   * ao mesmo tempo. Sem a condição, o cancelamento estorna o crédito e a gravação de PROCESSANDO
   * sobrescreve o CANCELADA — a análise roda, é cobrada de novo, e o cliente vê o débito de uma análise
   * que acabou de cancelar. Duplo-clique em conexão lenta basta.
   *
   * `updateMany` com o status na condição faz a segunda escrita não encontrar nada: `count` zero. O
   * estorno já aconteceu e é idempotente, então repetir a ação é seguro — e é o que a pessoa fará ao
   * ver a tela recarregada.
   */
  const escrita = await prisma.analysis.updateMany({
    where: { id: analise.id, status: statusAnterior },
    data: { status },
  });
  if (escrita.count === 0) {
    /**
     * Perdeu a corrida: outra requisição mudou o status no meio. Não é erro de quem pediu — é estado
     * que mudou —, e por isso volta como recusa em vez de exceção. A tela recarrega e mostra a verdade.
     */
    return { statusAnterior, status: statusAnterior, creditosDevolvidos, tinhaRelatorio, creditoJaDevolvido, conflito: true };
  }

  await logAudit({
    actorId: ator.id,
    actorRole: ator.role,
    action: `analysis.${acao}`,
    entityType: "Analysis",
    entityId: analise.id,
    metadata: { statusAnterior, status, creditosDevolvidos, tinhaRelatorio },
  });

  return { statusAnterior, status, creditosDevolvidos, tinhaRelatorio, creditoJaDevolvido, conflito: false };
}

// ---------------------------------------------------------------------------
// Forçar situação — só ADMIN, e com freio
// ---------------------------------------------------------------------------

/**
 * Põe a análise num status escolhido à mão.
 *
 * ── Para que serve, e por que não é o mesmo que as ações acima ────────────────
 * É a saída do atendimento para o caso que os botões não cobrem: análise parada num estado que
 * nenhuma transição normal resolve. Sem isso, a única ferramenta do suporte para uma análise
 * emperrada era pedir ao cliente que apagasse e recomeçasse — perdendo os documentos e a análise que
 * ele pagou.
 *
 * ── Os dois destinos RECUSADOS, e o motivo de cada um ─────────────────────────
 * "Forçar" não pode significar "pode tudo", porque duas escolhas fazem o sistema mentir para o cliente:
 *
 *  1. **CONCLUIDA sem relatório.** O selo verde e o texto da tela dizem que a apuração está pronta, e
 *     não há nada para ler nem baixar. O cliente é levado a acreditar que recebeu o que pagou.
 *
 *  2. **Qualquer status de EXECUÇÃO.** Não existe motor rodando: a análise ficaria "Processando" para
 *     sempre até a varredura de manutenção a derrubar 30 minutos depois — e a varredura tentaria
 *     estornar um crédito que talvez nunca tenha sido cobrado. Forçar aqui cria justamente a análise
 *     travada que a varredura existe para consertar.
 *
 * Nunca mexe em crédito, e isso é regra, não esquecimento: quem força um status está consertando
 * exibição, e dinheiro não se move por efeito colateral de um conserto de tela. Devolver crédito
 * continua sendo ato próprio (cancelar sem entrega, ou o estorno na ferramenta de assinaturas).
 */
export type RecusaDeForca =
  | "destino_igual"
  | "concluida_sem_relatorio"
  | "execucao_sem_motor"
  | "motivo_ausente"
  /** A análise está sendo processada AGORA: mexer no status atropela o motor. */
  | "execucao_viva"
  /** O status mudou entre a leitura e a gravação — nada foi aplicado. */
  | "conflito";

export const MENSAGEM_DA_RECUSA_DE_FORCA: Record<RecusaDeForca, string> = {
  destino_igual: "A análise já está nesse status.",
  concluida_sem_relatorio:
    "Não é possível marcar como Concluída uma análise sem relatório: a tela diria ao cliente que o" +
    " resultado está pronto e não haveria nada para ler. Processe a análise, ou use Aguardando informações.",
  execucao_sem_motor:
    "Não é possível pôr a análise num status de processamento à mão: nenhum motor está rodando, então" +
    " ela ficaria \"processando\" até a varredura de manutenção derrubá-la. Use Erro de processamento e" +
    " peça o reprocessamento.",
  motivo_ausente: "Informe o motivo: ele fica na auditoria e é o que explica a alteração depois.",
  execucao_viva:
    "Esta análise está sendo processada agora, com sinal de atividade recente. Aguarde o fim do" +
    " processamento: mexer no status durante a execução é sobrescrito pelo motor minutos depois, e o" +
    " conserto se perde sem deixar sinal.",
  conflito:
    "A situação desta análise mudou enquanto você preenchia — nada foi alterado. Recarregue a lista e" +
    " confira o status atual antes de tentar de novo.",
};

export interface ResultadoDaForca {
  statusAnterior: AnalysisStatus;
  status: AnalysisStatus;
}

export async function forcarSituacao(
  analise: AnaliseParaSituacao,
  destino: AnalysisStatus,
  motivo: string,
  ator: { id: string; role: Role },
): Promise<{ ok: true; resultado: ResultadoDaForca } | { ok: false; recusa: RecusaDeForca }> {
  const razao = motivo.trim();
  if (razao.length < 5) return { ok: false, recusa: "motivo_ausente" };
  if (destino === analise.status) return { ok: false, recusa: "destino_igual" };
  if (STATUS_EM_EXECUCAO.includes(destino)) return { ok: false, recusa: "execucao_sem_motor" };

  /**
   * ⚠️ E não mexe em análise que está rodando AGORA.
   *
   * A recusa acima cuida do DESTINO ser de execução; esta cuida da ORIGEM. Faltava, e o efeito era o
   * mesmo que `podeExecutar` descreve para o cancelamento: o motor está processando noutro lugar e vai
   * gravar o status dele ao terminar, apagando o que o atendimento acabou de escrever. O suporte veria
   * a alteração "dar certo" e ser desfeita minutos depois, sem nada explicando — e tentaria de novo.
   *
   * Execução MORTA (sem sinal de vida) segue liberada: é justamente o caso em que forçar tem valor.
   */
  if (STATUS_EM_EXECUCAO.includes(analise.status)) {
    const morta = ultimoSinal(analise).getTime() < Date.now() - MINUTOS_SEM_SINAL_DE_VIDA * 60_000;
    if (!morta) return { ok: false, recusa: "execucao_viva" };
  }

  if (destino === "CONCLUIDA") {
    const relatorios = await prisma.report.count({ where: { analysisId: analise.id } });
    if (relatorios === 0) return { ok: false, recusa: "concluida_sem_relatorio" };
  }

  const statusAnterior = analise.status;
  /** Compare-and-set, pelo mesmo motivo de `aplicarSituacao`: o status pode ter mudado desde a leitura. */
  const escrita = await prisma.analysis.updateMany({
    where: { id: analise.id, status: statusAnterior },
    data: {
      status: destino,
      /**
       * `completedAt` acompanha o destino porque a rota de processar o lê como "esta análise já rodou",
       * para decidir se a execução conta como reprocessamento.
       *
       * ⚠️ Ele NÃO é mais o que decide o desarquivamento — aquilo passou a ler a auditoria do
       * arquivamento. A dedução por `completedAt` estava errada na raiz: o motor grava a data ao ir para
       * AGUARDANDO_REVISAO, não na conclusão. Ver `destinoDoDesarquivamento`.
       */
      ...(destino === "CONCLUIDA" && !analise.completedAt ? { completedAt: new Date() } : {}),
    },
  });
  if (escrita.count === 0) return { ok: false, recusa: "conflito" };

  await logAudit({
    actorId: ator.id,
    actorRole: ator.role,
    action: "analysis.status_forcado",
    entityType: "Analysis",
    entityId: analise.id,
    /** O motivo é o ponto do registro: status mudado à mão sem razão escrita é rastro sem valor. */
    metadata: { statusAnterior, status: destino, motivo: razao },
  });

  return { ok: true, resultado: { statusAnterior, status: destino } };
}
