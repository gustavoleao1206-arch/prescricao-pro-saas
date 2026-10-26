import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

export const runtime = "nodejs";

/**
 * Encerra o caso de uma quantia PENDENTE — dinheiro que entrou sem destino.
 *
 * ── Por que precisa existir uma saída manual ──────────────────────────────────
 * A devolução feita no painel do Asaas fecha o caso sozinha, pelo webhook de estorno
 * (ver `estornoDePendente`). Mas o outro desfecho não gera evento NENHUM: quando o
 * pagador é identificado e o acesso é liberado à mão, o Asaas não tem o que avisar. Sem
 * esta rota, a linha ficaria na tela de pendências para sempre — e uma tela de
 * pendências que só cresce é uma tela que ninguém lê. O registro perderia justamente a
 * função pela qual foi criado.
 *
 * ── Os três desfechos, e por que não são dois ─────────────────────────────────
 *  - `devolvido`  → ESTORNADO. O dinheiro voltou ao pagador.
 *  - `aplicado`   → APROVADO. Virou acesso para alguém: é receita, e passa a contar
 *                   como tal.
 *  - `duplicado`  → CANCELADO. O caso foi resolvido por OUTRO lançamento — o mais
 *                   comum é a ativação manual, que cria o próprio registro APROVADO
 *                   (ver src/lib/ativacao-manual.ts). Marcar esta linha como aplicada
 *                   contaria o mesmo dinheiro duas vezes na receita; marcar como
 *                   estornada afirmaria uma devolução que não houve. Faltava um estado
 *                   para "encerrado, e não é dinheiro novo".
 *
 * O motivo é obrigatório: é ele que permite auditar depois quem recebeu a quantia. O
 * registro nunca é apagado — a linha muda de estado e a auditoria guarda o resto.
 */
const schema = z.object({
  destino: z.enum(["devolvido", "aplicado", "duplicado"]),
  motivo: z.string().trim().min(5, "Descreva o que foi feito com a quantia."),
});

const DESTINOS = {
  devolvido: { status: "ESTORNADO" as const, texto: "devolvida ao pagador" },
  aplicado: { status: "APROVADO" as const, texto: "aplicada a uma conta" },
  duplicado: { status: "CANCELADO" as const, texto: "encerrada como já registrada em outro lançamento" },
};

export const POST = route(async (req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const admin = await requireRole("ADMIN");
  const { destino, motivo } = schema.parse(await req.json());

  const pagamento = await prisma.payment.findUnique({ where: { id: params.id } });
  if (!pagamento) return fail("Pagamento não encontrado.", 404);

  /**
   * Só quantia PENDENTE se encerra por aqui. A checagem não é formalidade: sem ela,
   * esta rota viraria um jeito de reescrever o status de qualquer pagamento do
   * sistema — inclusive transformar um estorno legítimo em receita.
   */
  if (pagamento.status !== "PENDENTE") {
    return fail(`Este caso já está encerrado (situação atual: ${pagamento.status}).`, 409);
  }

  const alvo = DESTINOS[destino];
  await prisma.payment.update({
    where: { id: pagamento.id },
    // `paidAt` só é preenchido quando a quantia virou serviço de fato.
    data: { status: alvo.status, ...(destino === "aplicado" ? { paidAt: new Date() } : {}) },
  });

  await logAudit({
    actorId: admin.id,
    actorRole: "ADMIN",
    action: `admin.pagamento.${destino}`,
    entityType: "Payment",
    entityId: pagamento.id,
    metadata: {
      de: "PENDENTE",
      para: alvo.status,
      valorCents: pagamento.amountCents,
      cobrancaNoProvedor: pagamento.externalId,
      motivo,
    },
  });

  return ok({
    id: pagamento.id,
    status: alvo.status,
    message: `Caso encerrado: quantia ${alvo.texto}.`,
  });
});
