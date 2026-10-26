import { prisma } from "@/lib/db";
import { SubscriptionStatusBadge } from "@/components/ui/badge";
import { AdminSubscriptionActions } from "@/components/admin/subscription-actions";
import { ManualActivation, type PlanoOpcao } from "@/components/admin/manual-activation";
import { PendingCycles, type CicloPendenteItem } from "@/components/admin/pending-cycles";
import { ciclosPendentes } from "@/lib/ativacao-manual";
import { prazoDaRevisao } from "@/lib/revisao-contestacao";
import { brl, dateBR } from "@/lib/format";
import { renovacaoDe } from "@/lib/renovacao";

export const dynamic = "force-dynamic";

export default async function AdminAssinaturasPage() {
  const [subs, byStatus, mrrAgg, planos, pendentes] = await Promise.all([
    prisma.subscription.findMany({
      orderBy: { createdAt: "desc" },
      take: 300,
      include: {
        organization: { select: { name: true, owner: { select: { email: true } } } },
        plan: { select: { name: true } },
      },
    }),
    prisma.subscription.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.subscription.aggregate({ where: { status: "ATIVA" }, _sum: { amountCents: true } }),
    // Planos disponíveis para a liberação manual. `contactOnly` ENTRA aqui de
    // propósito: o plano Empresarial é exatamente o que se vende por contrato,
    // fora do checkout — é o caso de uso principal desta tela.
    prisma.plan.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
      select: { slug: true, name: true, period: true, priceCents: true, monthlyAnalyses: true },
    }),
    ciclosPendentes(),
  ]);

  const count = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
  const mrr = mrrAgg._sum.amountCents ?? 0;

  const resumo = [
    { label: "MRR (recorrente/mês)", value: brl(mrr), highlight: true },
    { label: "Ativas", value: count("ATIVA") },
    { label: "Inadimplentes", value: count("INADIMPLENTE") },
    { label: "Suspensas", value: count("SUSPENSA") },
    { label: "Canceladas", value: count("CANCELADA") },
  ];

  const opcoes: PlanoOpcao[] = planos.map((p) => ({
    slug: p.slug,
    nome: p.name,
    periodo: p.period,
    precoCents: p.priceCents,
    creditos: p.monthlyAnalyses,
  }));

  const itensPendentes: CicloPendenteItem[] = pendentes.map((c) => ({
    subscriptionId: c.subscriptionId,
    organizacao: c.organizacao,
    cliente: c.cliente,
    email: c.email,
    plano: c.plano,
    periodo: c.periodo,
    cotaDoCiclo: c.cotaDoCiclo,
    saldoAtual: c.saldoAtual,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl">Assinaturas ({subs.length})</h1>
        <div className="flex flex-wrap items-center gap-3">
          <a href="/api/admin/assinaturas/export" className="btn-outline text-sm">Exportar CSV</a>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {resumo.map((r) => (
          <div key={r.label} className={`card p-4 ${r.highlight ? "border-marca-300" : ""}`}>
            <div className="text-xs uppercase text-neutro-400">{r.label}</div>
            <div className="mt-1 text-xl font-bold text-marinho-700">{r.value}</div>
          </div>
        ))}
      </div>

      <ManualActivation planos={opcoes} />

      <section>
        <h2 className="mb-3 text-lg">Créditos do mês pendentes</h2>
        <PendingCycles itens={itensPendentes} />
      </section>

      <section>
        <h2 className="mb-3 text-lg">Todas as assinaturas</h2>
        <div className="overflow-x-auto rounded-2xl border border-neutro-200 bg-white dark:border-neutro-700 dark:bg-neutro-900">
          <table className="w-full text-sm">
            <thead className="bg-neutro-50 text-left text-xs uppercase text-neutro-400 dark:bg-neutro-800">
              <tr>
                <th className="px-4 py-3">Organização</th>
                <th className="px-4 py-3">Plano</th>
                <th className="px-4 py-3">Valor</th>
                <th className="px-4 py-3">Origem</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Consumo</th>
                {/*
                  "Próxima cobrança" exibia `currentPeriodEnd` para todos, e nem toda
                  assinatura cobra de novo: PIX é cobrança única e cancelada não cobra
                  mais. Na conferência financeira isso inflava a expectativa de receita —
                  o painel mostrava data de cobrança para quem nunca mais vai pagar.
                */}
                <th className="px-4 py-3">Fim do período / cobrança</th>
                <th className="px-4 py-3">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutro-100 dark:divide-neutro-800">
              {subs.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-marinho-700 dark:text-neutro-100">{s.organization.name}</div>
                    {s.organization.owner?.email && (
                      <div className="text-xs text-neutro-400">{s.organization.owner.email}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">{s.plan.name}</td>
                  <td className="px-4 py-3">{brl(s.amountCents)}</td>
                  {/* Origem deixa visível o que foi liberado à mão — útil na
                      conferência financeira, já que venda manual não tem
                      contrapartida no extrato do gateway. */}
                  <td className="px-4 py-3 text-xs text-neutro-500">{s.provider}</td>
                  <td className="px-4 py-3"><SubscriptionStatusBadge status={s.status} /></td>
                  <td className="px-4 py-3">
                    {s.analysesQuota === 0
                      ? `${s.analysesUsed} / ∞`
                      : `${s.analysesUsed} / ${s.analysesQuota}${s.extraAnalyses > 0 ? ` +${s.extraAnalyses}` : ""}`}
                  </td>
                  <td className="px-4 py-3 text-neutro-500">
                    {dateBR(renovacaoDe(s).data)}
                    <div className="text-xs text-neutro-400">{renovacaoDe(s).formaDeCobranca}</div>
                  </td>
                  <td className="px-4 py-3">
                    {/* O prazo da revisão vai calculado do servidor: é ele que diz
                        ao admin quanto tempo resta antes de o acesso voltar sozinho. */}
                    <AdminSubscriptionActions
                      id={s.id}
                      status={s.status}
                      prazoRevisao={prazoDaRevisao(s)?.toISOString() ?? null}
                      suspensaEm={s.suspendedAt?.toISOString() ?? null}
                      revisaoProrrogada={Boolean(s.revisaoProrrogadaEm)}
                    />
                  </td>
                </tr>
              ))}
              {subs.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-neutro-500">
                    Nenhuma assinatura ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
