import { route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { montarCsv } from "@/lib/csv";

export const runtime = "nodejs";

/** Exporta as assinaturas em CSV (apenas ADMIN). Registrado em auditoria. */
export const GET = route(async () => {
  const admin = await requireRole("ADMIN");

  const subs = await prisma.subscription.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      organization: { select: { name: true, owner: { select: { email: true } } } },
      plan: { select: { name: true } },
    },
  });

  const header = ["Organizacao", "Email", "Plano", "ValorBRL", "Status", "Provider", "RefExterna", "Inicio", "ProximaCobranca", "CanceladaEm", "AnalisesUsadas"];
  const rows = subs.map((s) => [
    s.organization.name,
    s.organization.owner?.email ?? "",
    s.plan.name,
    (s.amountCents / 100).toFixed(2),
    s.status,
    s.provider,
    s.externalRef ?? "",
    s.startedAt.toISOString().slice(0, 10),
    s.currentPeriodEnd?.toISOString().slice(0, 10) ?? "",
    s.canceledAt?.toISOString().slice(0, 10) ?? "",
    s.analysesUsed,
  ]);
  /** O escape mora em `@/lib/csv` — um lugar só, exercitado por teste. Ver o módulo para o ataque. */
  const csv = montarCsv(header, rows);

  await logAudit({ actorId: admin.id, actorRole: "ADMIN", action: "admin.subscription.export", metadata: { count: subs.length } });

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="assinaturas.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
});
