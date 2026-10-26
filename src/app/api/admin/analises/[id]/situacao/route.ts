import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import {
  aplicarSituacao,
  forcarSituacao,
  podeExecutar,
  MENSAGEM_DA_RECUSA_DE_FORCA,
  MENSAGEM_DE_RECUSA,
  type AcaoDeSituacao,
} from "@/lib/situacao-da-analise";
import { AnalysisStatus } from "@prisma/client";

export const runtime = "nodejs";

const corpo = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("acao"), acao: z.enum(["cancelar", "arquivar", "desarquivar"]) }),
  z.object({
    tipo: z.literal("forcar"),
    status: z.nativeEnum(AnalysisStatus),
    /** O motivo é obrigatório aqui e não no fluxo do cliente: quem age sobre a análise de OUTRA pessoa
     * precisa deixar escrito por quê. Sem isso o registro diz "o admin mudou o status" e nada mais. */
    motivo: z.string().min(5, "Descreva o motivo em poucas palavras."),
  }),
]);

/**
 * Ações do atendimento sobre a análise de um cliente.
 *
 * ── O que não existia ─────────────────────────────────────────────────────────
 * NENHUMA ação administrativa sobre análise. A tela `/admin/analises` era uma tabela de leitura de 38
 * linhas, e a única rota capaz de mudar o status de uma análise (`PATCH /api/analises/[id]`) não tinha
 * chamador nenhum, não validava transição e ignorava crédito. Diante de uma análise emperrada, a única
 * ferramenta do suporte era pedir ao cliente que apagasse e recomeçasse — perdendo os documentos e a
 * análise que ele pagou.
 *
 * ── Duas coisas diferentes, no mesmo lugar ────────────────────────────────────
 *  - `acao`: as mesmas cancelar/arquivar/desarquivar do cliente, com as MESMAS regras e o mesmo efeito
 *    em crédito. Reaproveitar é o ponto: se o suporte cancelasse por um caminho próprio, cancelar em
 *    nome do cliente devolveria crédito diferente de o cliente cancelar.
 *  - `forcar`: põe o status à mão, para o que os botões não cobrem. Exige motivo, recusa os destinos
 *    que fariam o sistema mentir e nunca mexe em crédito. Ver `src/lib/situacao-da-analise.ts`.
 */
export const PATCH = route(async (req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const admin = await requireRole("ADMIN");

  const dados = corpo.safeParse(await req.json().catch(() => null));
  if (!dados.success) return fail(dados.error.issues[0]?.message ?? "Dados inválidos.", 422);

  /**
   * Leitura direta, sem `getAnalysisForContext`: aquela função filtra por organização do CHAMADOR, e
   * aqui o chamador é o administrador agindo sobre a análise de outra pessoa. O grupo `/api/admin`
   * já exige o papel ADMIN acima.
   */
  const analise = await prisma.analysis.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      status: true,
      heartbeatAt: true,
      updatedAt: true,
      completedAt: true,
      title: true,
      owner: { select: { name: true, email: true } },
    },
  });
  if (!analise) return fail("Análise não encontrada.", 404);

  const ator = { id: admin.id, role: admin.role };

  if (dados.data.tipo === "acao") {
    const acao = dados.data.acao as AcaoDeSituacao;
    const veredito = podeExecutar(acao, analise);
    if (!veredito.pode) {
      return fail(MENSAGEM_DE_RECUSA[veredito.recusa!], 409, { reason: veredito.recusa });
    }
    const r = await aplicarSituacao(acao, analise, ator);
    if (r.conflito) {
      return fail(MENSAGEM_DA_RECUSA_DE_FORCA.conflito, 409, { reason: "conflito" });
    }
    /**
     * A resposta ao ADMIN diz se houve devolução de crédito — em nome de quem, é a análise do cliente.
     * Cancelar em nome dele pode mover o saldo dele, e quem fez isso precisa ver que moveu.
     */
    return ok({
      status: r.status,
      creditosDevolvidos: r.creditosDevolvidos,
      message:
        r.creditosDevolvidos > 0
          ? `Análise ${r.status.toLowerCase()} e ${r.creditosDevolvidos} crédito(s) devolvido(s) ao saldo de ${analise.owner.name}.`
          : `Análise ${r.status.toLowerCase()}. Nenhum crédito foi movido.`,
    });
  }

  const r = await forcarSituacao(analise, dados.data.status, dados.data.motivo, ator);
  if (!r.ok) return fail(MENSAGEM_DA_RECUSA_DE_FORCA[r.recusa], 409, { reason: r.recusa });

  return ok({
    status: r.resultado.status,
    /** Dito em toda resposta, para não haver dúvida: forçar status NÃO devolve nem cobra crédito. */
    creditosDevolvidos: 0,
    message:
      `Status alterado de ${r.resultado.statusAnterior} para ${r.resultado.status}. Nenhum crédito foi` +
      ` movido — devolver crédito continua sendo ação própria.`,
  });
});
