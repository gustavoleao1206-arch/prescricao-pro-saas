import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail, route } from "@/lib/api";
import { requireAppContext, getAnalysisForContext } from "@/lib/tenant";
import {
  aplicarSituacao,
  podeExecutar,
  MENSAGEM_DE_RECUSA,
  type AcaoDeSituacao,
  type ResultadoDaSituacao,
} from "@/lib/situacao-da-analise";

export const runtime = "nodejs";

const corpo = z.object({ acao: z.enum(["cancelar", "arquivar", "desarquivar"]) });

/**
 * Cancelar, arquivar e desarquivar a própria análise.
 *
 * ── O beco sem saída que isto abre ────────────────────────────────────────────
 * O cliente com uma análise em ERRO_PROCESSAMENTO e o limite de três reprocessamentos esgotado tinha
 * UMA opção na tela: Excluir. Ela apaga os documentos e não devolve crédito nenhum — ou seja, a única
 * saída oferecida a quem pagou e não recebeu era destruir a prova de que pagou, e ficar sem o dinheiro.
 *
 * Cancelar resolve as duas coisas: encerra a análise sem apagar nada e devolve o crédito quando não
 * houve entrega. A regra do crédito e as transições vivem em `src/lib/situacao-da-analise.ts`, junto da
 * razão de cada uma.
 *
 * ── Não é DELETE, e a diferença importa ───────────────────────────────────────
 * Excluir apaga a análise, os documentos do armazenamento e o histórico. Cancelar preserva tudo: os
 * documentos que o cliente subiu continuam lá, a análise segue no histórico com o selo "Cancelada", e o
 * atendimento consegue reconstituir o que houve. Num produto em que a saída é usada em processo
 * judicial, apagar é a ação que quase nunca é a certa.
 */
export const POST = route(async (req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const ctx = await requireAppContext();
  const analysis = await getAnalysisForContext(params.id, ctx);
  if (!analysis) return fail("Análise não encontrada.", 404);

  /**
   * Mesma permissão de PATCH e DELETE nesta pasta: o dono ou o administrador. Membro da mesma
   * organização lê a análise, mas mudar a situação da análise de outra pessoa não é leitura.
   */
  if (analysis.ownerId !== ctx.user.id && ctx.user.role !== "ADMIN") {
    return fail(MENSAGEM_DE_RECUSA.sem_permissao, 403, { reason: "sem_permissao" });
  }

  const dados = corpo.safeParse(await req.json().catch(() => null));
  if (!dados.success) return fail("Ação inválida.", 422);
  const acao = dados.data.acao as AcaoDeSituacao;

  const veredito = podeExecutar(acao, analysis);
  if (!veredito.pode) {
    /**
     * 409, não 422: o pedido está bem formado e a ação existe — é o ESTADO da análise que não permite.
     * Execução viva é o caso claro: a mesma ação passa a ser possível meia hora depois.
     */
    return fail(MENSAGEM_DE_RECUSA[veredito.recusa!], 409, { reason: veredito.recusa });
  }

  const r = await aplicarSituacao(acao, analysis, { id: ctx.user.id, role: ctx.user.role });

  /**
   * Perdeu a corrida com outra requisição: o status mudou entre a leitura e a gravação, e nada foi
   * aplicado. Responder 200 aqui faria a pessoa acreditar que cancelou uma análise que segue rodando.
   */
  if (r.conflito) {
    return fail(
      "A situação desta análise mudou enquanto você clicava — nada foi alterado. Recarregue a página e" +
        " confira o status atual.",
      409,
      { reason: "conflito" },
    );
  }

  return ok({
    status: r.status,
    creditosDevolvidos: r.creditosDevolvidos,
    message: mensagemDeSucesso(acao, r),
  });
});

/**
 * A mensagem diz o que aconteceu com o DINHEIRO, sempre — inclusive quando nada aconteceu.
 *
 * Cancelar é a ação que o cliente usa quando pagou e não recebeu. Se a tela só disser "análise
 * cancelada", ele não sabe se o crédito voltou, e a dúvida vira chamado de suporte no melhor caso e
 * pedido de estorno no cartão no pior. Silêncio sobre crédito, aqui, custa mais que o crédito.
 */
function mensagemDeSucesso(acao: AcaoDeSituacao, r: ResultadoDaSituacao): string {
  if (acao === "arquivar") {
    return "Análise arquivada. Ela sai da sua lista, mas continua guardada — use o filtro Arquivadas para vê-la.";
  }
  if (acao === "desarquivar") return "Análise desarquivada. Ela voltou para a sua lista.";

  if (r.creditosDevolvidos > 0) {
    const quantia = r.creditosDevolvidos === 1 ? "1 crédito" : `${r.creditosDevolvidos} créditos`;
    return (
      `Análise cancelada e ${quantia} devolvido${r.creditosDevolvidos === 1 ? "" : "s"} ao seu saldo.` +
      " Os documentos continuam guardados."
    );
  }
  /**
   * ⚠️ "Já havia sido devolvido" é DIFERENTE de "não havia crédito", e acontece de verdade: a varredura
   * de manutenção estorna sozinha a análise cujo processamento morreu. Cancelar depois disso devolve
   * zero — e dizer "não havia crédito debitado" faria o cliente concluir que pagou e não recebeu nada
   * de volta, justamente quando o dinheiro já está no saldo dele.
   */
  if (r.creditoJaDevolvido) {
    return (
      "Análise cancelada. O crédito desta análise já havia sido devolvido ao seu saldo — confira em" +
      " Assinatura. Os documentos continuam guardados."
    );
  }
  if (r.tinhaRelatorio) {
    /**
     * Diz por que NÃO devolveu. Sem o motivo, a ausência da devolução parece falha do sistema — e a
     * pessoa reclama do que é regra. Com o motivo, ela entende que o trabalho foi feito.
     */
    return (
      "Análise cancelada. O crédito não é devolvido porque a apuração foi concluída e o relatório foi" +
      " gerado. Os documentos continuam guardados."
    );
  }
  return "Análise cancelada. Não havia crédito debitado nesta análise. Os documentos continuam guardados.";
}
