import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ajustarCreditosAdmin, assinaturasComCotaNoMes, liberarCreditosDoCiclo, saldoDe } from "@/lib/credits";
import { z } from "zod";

export const runtime = "nodejs";

/**
 * Operações de crédito da administração sobre uma assinatura.
 *
 * Tudo passa pelo motor de créditos (src/lib/credits.ts), que grava a
 * movimentação na razão com saldo anterior, saldo posterior, responsável e
 * motivo — nenhum caminho de ajuste manual escapa da auditoria.
 */
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("liberar"),
    creditos: z.number().int().positive().max(1000),
    motivo: z.string().min(3).max(300),
  }),
  z.object({
    action: z.literal("estornar"),
    creditos: z.number().int().positive().max(1000),
    motivo: z.string().min(3).max(300),
  }),
  z.object({
    action: z.literal("bonus"),
    creditos: z.number().int().positive().max(1000),
    motivo: z.string().min(3).max(300),
    validadeDias: z.number().int().positive().max(3650).optional(),
  }),
  z.object({
    action: z.literal("renovar-ciclo"),
    motivo: z.string().min(3).max(300),
    /** Confirmação explícita para liberar uma SEGUNDA cota no mesmo mês. */
    forcar: z.boolean().optional(),
  }),
]);

export const POST = route(async (req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const admin = await requireRole("ADMIN");
  const corpo = schema.parse(await req.json());

  const sub = await prisma.subscription.findUnique({ where: { id: params.id } });
  if (!sub) return fail("Assinatura não encontrada.", 404);

  try {
    if (corpo.action === "renovar-ciclo") {
      /**
       * Guarda contra liberar duas vezes no mesmo mês por caminhos diferentes.
       *
       * A liberação nascida de PAGAMENTO usa a identidade do pagamento na chave; a
       * manual usa o mês. Chaves diferentes não colidem, então nada impedia o
       * administrador de entregar uma segunda cota no mês em que o cliente já havia
       * recebido a dele — e o quadro de "ciclos pendentes" já convidava a isso quando
       * procurava a chave errada. A pergunta certa é a mesma que o painel faz agora:
       * houve liberação de cota neste mês?
       */
      const jaTem = await assinaturasComCotaNoMes([sub.id]);
      if (jaTem.has(sub.id) && !corpo.forcar) {
        return fail(
          "Esta assinatura já recebeu a cota deste mês. Liberar de novo entregaria crédito em dobro — " +
            "se for mesmo o caso (cortesia, correção de erro), repita marcando a confirmação.",
          409,
        );
      }
      const r = await liberarCreditosDoCiclo(sub.id, {
        descricao: `Renovação manual — ${corpo.motivo}`,
        // Forçado no mesmo mês precisa de identidade própria, senão a chave do mês
        // faria a segunda liberação virar silenciosamente um no-op.
        ...(jaTem.has(sub.id) ? { ciclo: `manual:${Date.now()}` } : {}),
      });
      return ok({ liberados: r.liberados, jaLiberado: r.jaLiberado, saldo: saldoDe(await recarregar(sub.id)).total });
    }

    // Liberar/bonificar somam; estornar subtrai. O motor recusa deixar o saldo
    // negativo e exige o motivo, então a validação forte vive lá, não aqui.
    const quantidade = corpo.action === "estornar" ? -corpo.creditos : corpo.creditos;
    const r = await ajustarCreditosAdmin(sub.id, quantidade, {
      actorId: admin.id,
      motivo: corpo.motivo,
      bonus: corpo.action === "bonus",
      validadeDias: corpo.action === "bonus" ? corpo.validadeDias : undefined,
    });

    return ok({ saldoAnterior: r.saldoAnterior, saldoPosterior: r.saldoPosterior });
  } catch (err) {
    // Mensagem do domínio (saldo insuficiente, motivo ausente) é segura de exibir.
    return fail((err as Error).message, 422);
  }
});

async function recarregar(id: string) {
  return prisma.subscription.findUnique({ where: { id } });
}
