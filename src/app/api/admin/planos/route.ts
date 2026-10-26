import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const planSchema = z.object({
  slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/, "Use apenas letras minúsculas, números e hífen."),
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  priceCents: z.number().int().nonnegative().default(0),
  period: z.enum(["MENSAL", "ANUAL", "PACOTE", "UNICO"]).default("MENSAL"),
  trialDays: z.number().int().nonnegative().default(0),
  monthlyAnalyses: z.number().int().nonnegative().default(0),
  maxUsers: z.number().int().positive().default(1),
  storageMb: z.number().int().positive().default(1024),
  maxFileMb: z.number().int().positive().default(25),
  allowReports: z.boolean().default(true),
  allowPetitions: z.boolean().default(true),
  priorityProcessing: z.boolean().default(false),
  active: z.boolean().default(true),
});

/** Cria (ou atualiza pelo slug) um plano — configuração comercial sem editar código. */
export const POST = route(async (req: NextRequest) => {
  const admin = await requireRole("ADMIN");
  const data = planSchema.parse(await req.json());

  const plan = await prisma.plan.upsert({
    where: { slug: data.slug },
    update: data,
    create: data,
  });

  await logAudit({ actorId: admin.id, actorRole: "ADMIN", action: "admin.plan.upsert", entityType: "Plan", entityId: plan.id, metadata: { slug: plan.slug } });
  return ok({ id: plan.id, slug: plan.slug }, { status: 201 });
});
