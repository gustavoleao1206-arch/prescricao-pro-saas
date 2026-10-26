import Link from "next/link";
import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { AnalysisStatusBadge } from "@/components/ui/badge";
import { dateBR } from "@/lib/format";
import { GRUPOS_DE_SITUACAO, grupoDaUrl, type GrupoDeSituacao } from "@/lib/situacao-da-analise";

export const dynamic = "force-dynamic";

/**
 * Abas oferecidas ao cliente. Menos que as do administrador de propósito: ele quer saber o que está
 * em andamento e onde estão as que guardou, não triar fila de atendimento.
 */
const ABAS: GrupoDeSituacao[] = ["ativas", "arquivadas", "canceladas", "todas"];

export default async function AnalisesPage({ searchParams: searchParamsAsync }: { searchParams: Promise<{ situacao?: string }> }) {
  const searchParams = await searchParamsAsync;
  const ctx = await getAppContext();
  if (!ctx) redirect("/login");

  const grupo = grupoDaUrl(searchParams.situacao);
  const status = GRUPOS_DE_SITUACAO[grupo].status;

  /**
   * ⚠️ O PADRÃO ESCONDE arquivadas e canceladas, e é isso que dá sentido a arquivar.
   *
   * Antes a lista trazia tudo, sem filtro e sem limite. Com o arquivamento implementado, manter tudo na
   * mesma tela tornaria o botão "Arquivar" decorativo: a análise arquivada continuaria no mesmo lugar da
   * lista, e o cliente concluiria que arquivar não faz nada.
   */
  /** Sem organização não há análise a listar — e o isolamento por organização é o que separa clientes. */
  const orgId = ctx.organization?.id ?? null;

  const [analyses, contagens] = orgId
    ? await Promise.all([
        prisma.analysis.findMany({
          where: { organizationId: orgId, ...(status ? { status: { in: status } } : {}) },
          orderBy: { createdAt: "desc" },
          include: { _count: { select: { documents: true, reports: true, petitions: true } } },
        }),
        /**
         * A contagem por grupo vai no rótulo da aba. Sem ela, a análise arquivada desaparece da tela e
         * nada indica para onde foi — e quem arquivou por engano não encontra o caminho de volta.
         */
        prisma.analysis.groupBy({
          by: ["status"],
          where: { organizationId: orgId },
          _count: { _all: true },
        }),
      ])
    : [[], []];

  const porGrupo = (g: GrupoDeSituacao) => {
    const lista = GRUPOS_DE_SITUACAO[g].status;
    return contagens
      .filter((c) => !lista || lista.includes(c.status))
      .reduce((soma, c) => soma + c._count._all, 0);
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl">Minhas análises</h1>
        <Link href="/nova-analise" className="btn-primary">＋ Nova análise</Link>
      </div>

      {/* Filtro por link, sem estado no cliente: o servidor recalcula a lista. */}
      <nav aria-label="Situação" className="mb-6 flex flex-wrap gap-2">
        {ABAS.map((g) => {
          const total = porGrupo(g);
          const ativa = g === grupo;
          return (
            <Link
              key={g}
              href={g === "ativas" ? "/analises" : `/analises?situacao=${g}`}
              aria-current={ativa ? "page" : undefined}
              className={`badge ${
                ativa ? "bg-marca-600 text-white" : "bg-neutro-100 text-neutro-600 hover:bg-neutro-200"
              }`}
            >
              {GRUPOS_DE_SITUACAO[g].rotulo} ({total})
            </Link>
          );
        })}
      </nav>

      {analyses.length === 0 ? (
        <div className="card p-10 text-center text-neutro-500">
          {grupo === "ativas" && porGrupo("todas") > 0 ? (
            /**
             * Lista vazia com análises existentes noutro grupo é o caso que mais confunde: sem esta
             * distinção, quem arquivou tudo veria "você ainda não tem análises" e acharia que perdeu o
             * trabalho.
             */
            <>
              Nenhuma análise ativa. Suas análises encerradas estão em{" "}
              <Link href="/analises?situacao=arquivadas" className="text-marca-600 underline">Arquivadas</Link> e{" "}
              <Link href="/analises?situacao=canceladas" className="text-marca-600 underline">Canceladas</Link>.
            </>
          ) : grupo === "ativas" ? (
            <>
              Você ainda não tem análises.{" "}
              <Link href="/nova-analise" className="text-marca-600 underline">Crie a primeira</Link>.
            </>
          ) : (
            <>Nenhuma análise nesta situação.</>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutro-200 bg-white dark:border-neutro-700 dark:bg-neutro-900">
          <table className="w-full text-sm">
            <thead className="bg-neutro-50 text-left text-xs uppercase tracking-wide text-neutro-400 dark:bg-neutro-800">
              <tr>
                <th className="px-4 py-3">Análise</th>
                <th className="px-4 py-3">Processo</th>
                <th className="px-4 py-3">Criada</th>
                <th className="px-4 py-3">Docs</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutro-100 dark:divide-neutro-800">
              {analyses.map((a) => (
                <tr key={a.id} className="hover:bg-neutro-50 dark:hover:bg-neutro-800/50">
                  <td className="px-4 py-3">
                    <Link href={`/analises/${a.id}`} className="font-medium text-marinho-700 hover:underline">{a.title}</Link>
                  </td>
                  <td className="px-4 py-3 text-neutro-500">{a.processNumber ?? "-"}</td>
                  <td className="px-4 py-3 text-neutro-500">{dateBR(a.createdAt)}</td>
                  <td className="px-4 py-3 text-neutro-500">{a._count.documents}</td>
                  <td className="px-4 py-3"><AnalysisStatusBadge status={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
