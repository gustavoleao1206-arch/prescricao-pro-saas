import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireAppContext, assertActiveSubscription, garantirOrganizacao } from "@/lib/tenant";
import { agentRateAllowed } from "@/lib/rate-limit";
import { analysisIdentificationSchema, analysisFactsSchema } from "@/lib/validation";
import { encryptField } from "@/lib/crypto";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createSchema = z.object({
  identification: analysisIdentificationSchema,
  facts: analysisFactsSchema.optional(),
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await requireAppContext();
  /**
   * A organização é CRIADA se ainda não existir, em vez de recusar.
   *
   * A linha aqui era `if (!ctx.organization) return fail("Organização não encontrada.", 400)`.
   * Recusar era estranho: a conta existe, está autenticada, e criar a organização é barato
   * e automático em todos os outros caminhos (cadastro pelo site, primeira aprovação de
   * pagamento no webhook, liberação manual pelo painel). Quem não passou por nenhum
   * deles — o ADMIN da semente, um REVISOR, um SUPORTE — não conseguia criar análise
   * nenhuma, e a mensagem não dizia o que fazer porque não havia nada a fazer.
   *
   * Ver `garantirOrganizacao`, em src/lib/tenant.ts, que é a única cópia desta regra.
   */
  const organizacao = ctx.organization ?? (await garantirOrganizacao(ctx.user.id, ctx.user.name));
  // Gate NO SERVIDOR: exige assinatura ativa (isento p/ equipe interna) + uso justo.
  assertActiveSubscription(ctx);
  if (!agentRateAllowed(ctx.user.id, "create"))
    return fail("Muitas solicitações em pouco tempo. Aguarde alguns segundos e tente novamente.", 429);
  if (ctx.user.role === "CLIENTE" && !ctx.quota.allowed)
    return fail("Limite de análises do plano atingido. Adquira análises adicionais.", 402);

  const { identification: id, facts } = createSchema.parse(await req.json());

  const analysis = await prisma.analysis.create({
    data: {
      organizationId: organizacao.id,
      ownerId: ctx.user.id,
      title: id.title,
      type: id.type,
      objective: id.objective,
      processNumber: id.processNumber,
      court: id.court,
      jurisdiction: id.jurisdiction,
      courtDivision: id.courtDivision,
      creditor: id.creditor,
      debtor: id.debtor,
      debtorDocEnc: id.debtorDocument ? encryptField(id.debtorDocument) : null,
      taxType: id.taxType,
      publicEntity: id.publicEntity,
      cdaNumber: id.cdaNumber,
      dividaAtivaNumber: id.dividaAtivaNumber,
      approxValueCents: id.approxValue != null ? Math.round(id.approxValue * 100) : null,
      facts: facts ?? {},
      status: "RASCUNHO",
    },
  });

  await logAudit({ actorId: ctx.user.id, actorRole: ctx.user.role, action: "analysis.create", entityType: "Analysis", entityId: analysis.id });
  return ok({ id: analysis.id }, { status: 201 });
});

export const GET = route(async () => {
  const ctx = await requireAppContext();
  if (!ctx.organization) return ok({ analyses: [] });
  const analyses = await prisma.analysis.findMany({
    where: { organizationId: ctx.organization.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, type: true, status: true, processNumber: true, createdAt: true, completedAt: true, confidence: true },
  });
  return ok({ analyses });
});
