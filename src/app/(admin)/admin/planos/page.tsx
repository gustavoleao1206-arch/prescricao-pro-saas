import { prisma } from "@/lib/db";
import { PlanForm } from "@/components/admin/plan-form";
import { brl, periodLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminPlanosPage() {
  const planos = await prisma.plan.findMany({ orderBy: { priceCents: "asc" } });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl">Planos</h1>
        <PlanForm />
      </div>
      <div className="overflow-x-auto rounded-2xl border border-neutro-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutro-50 text-left text-xs uppercase text-neutro-400">
            <tr>
              <th className="px-4 py-3">Slug</th><th className="px-4 py-3">Nome</th><th className="px-4 py-3">Preço</th>
              <th className="px-4 py-3">Análises</th><th className="px-4 py-3">Usuários</th><th className="px-4 py-3">Ativo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutro-100">
            {planos.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-3 font-mono text-xs text-neutro-500">{p.slug}</td>
                <td className="px-4 py-3 font-medium text-marinho-700">{p.name}</td>
                <td className="px-4 py-3">{p.priceCents === 0 ? "Grátis" : `${brl(p.priceCents)}${periodLabel(p.period)}`}</td>
                <td className="px-4 py-3">{p.monthlyAnalyses === 0 ? "∞" : p.monthlyAnalyses}</td>
                <td className="px-4 py-3">{p.maxUsers}</td>
                <td className="px-4 py-3">{p.active ? "Sim" : "Não"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
