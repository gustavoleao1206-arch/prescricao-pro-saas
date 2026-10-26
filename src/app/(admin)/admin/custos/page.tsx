import Link from "next/link";
import { indicadoresDeCusto, indicadoresDeReceita, maioresConsumidores } from "@/lib/ai/custos";
import { brl, dateBR } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Custo de API x receita, painel interno da Leão Amorim Tecnologia.
 *
 * Os números desta tela NUNCA chegam ao cliente: ele enxerga créditos, não
 * tokens nem custo de provedor. Por isso a página vive só dentro de /admin
 * (o layout do grupo já barra quem não é ADMIN) e não abre rota de API própria.
 */

/** Janelas fixas no seletor: sem campo livre, os períodos ficam comparáveis. */
const PERIODOS = [7, 30, 90] as const;
const PERIODO_PADRAO = 30;

/** Só aceita as janelas conhecidas, searchParam é entrada de usuário. */
function janelaEmDias(bruto: string | undefined): number {
  const dias = Number(bruto);
  return (PERIODOS as readonly number[]).includes(dias) ? dias : PERIODO_PADRAO;
}

const numeroBR = (n: number) => n.toLocaleString("pt-BR");

export default async function AdminCustosPage({ searchParams }: { searchParams: Promise<{ dias?: string }> }) {
  const dias = janelaEmDias((await searchParams).dias);
  const ate = new Date();
  const desde = new Date(ate.getTime() - dias * 24 * 60 * 60 * 1000);

  const [custos, receita, consumidores] = await Promise.all([
    indicadoresDeCusto(desde, ate),
    indicadoresDeReceita(desde),
    maioresConsumidores(desde, 10),
  ]);

  // Valores em centavos vão para `brl`, que já faz a divisão por 100.
  const cardsCusto = [
    { label: "Custo de API no período", value: brl(custos.custoTotalCents), highlight: true },
    { label: "Custo médio por análise", value: brl(custos.custoMedioCents) },
    { label: "Análises no período", value: numeroBR(custos.analises) },
    { label: "Créditos consumidos", value: numeroBR(custos.creditosConsumidos) },
    { label: "Tokens de entrada", value: numeroBR(custos.tokensEntrada) },
    { label: "Tokens de saída", value: numeroBR(custos.tokensSaida) },
    { label: "Erros", value: numeroBR(custos.erros), warn: custos.erros > 0 },
    { label: "Reprocessamentos", value: numeroBR(custos.reprocessos), warn: custos.reprocessos > 0 },
  ];

  const cardsReceita = [
    { label: "Receita recorrente mensal", value: brl(receita.receitaRecorrenteMensalCents), highlight: true },
    { label: "Assinaturas ativas", value: numeroBR(receita.assinaturasAtivas) },
    { label: "Inadimplentes", value: numeroBR(receita.inadimplentes), warn: receita.inadimplentes > 0 },
    { label: "Cancelamentos", value: numeroBR(receita.canceladas) },
    { label: "Estornos", value: numeroBR(receita.estornadas), warn: receita.estornadas > 0 },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl">Custos e receita</h1>
          <p className="mt-1 text-sm text-neutro-500">
            {dateBR(desde)} a {dateBR(ate)} · números internos: o cliente vê apenas créditos.
          </p>
        </div>
        {/* Seletor de período por link: sem estado no cliente, o servidor recalcula tudo. */}
        <nav aria-label="Período" className="flex flex-wrap gap-2">
          {PERIODOS.map((d) => (
            <Link
              key={d}
              href={`/admin/custos?dias=${d}`}
              aria-current={d === dias ? "page" : undefined}
              className={`text-sm ${d === dias ? "btn-primary" : "btn-outline"}`}
            >
              {d} dias
            </Link>
          ))}
        </nav>
      </div>

      <Section title="Custo de API" cards={cardsCusto} />
      <Section title="Receita" cards={cardsReceita} />

      <section>
        <h2 className="mb-3 text-lg">Margem por plano</h2>
        <div className="overflow-x-auto rounded-2xl border border-neutro-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutro-50 text-left text-xs uppercase text-neutro-400">
              <tr>
                <th className="px-4 py-3">Plano</th>
                <th className="px-4 py-3">Assinaturas</th>
                <th className="px-4 py-3">Receita mensal</th>
                <th className="px-4 py-3">Custo médio/análise</th>
                <th className="px-4 py-3">Margem estimada</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutro-100">
              {receita.porPlano.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-neutro-500">
                    Nenhum plano com assinatura ativa.
                  </td>
                </tr>
              ) : (
                receita.porPlano.map((p) => (
                  <tr key={p.planSlug} className="hover:bg-neutro-50">
                    <td className="px-4 py-3 font-medium text-marinho-700">{p.planName}</td>
                    <td className="px-4 py-3">{numeroBR(p.assinaturas)}</td>
                    <td className="px-4 py-3">{brl(p.receitaMensalCents)}</td>
                    <td className="px-4 py-3">{brl(p.custoMedioCents)}</td>
                    {/* Margem negativa é o número que diz que o plano dá prejuízo. */}
                    <td
                      className={`px-4 py-3 font-semibold ${
                        p.margemEstimadaCents < 0 ? "text-alerta-700" : "text-marinho-700"
                      }`}
                    >
                      {brl(p.margemEstimadaCents)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-neutro-500">
          Margem estimada = receita mensal por assinante − custo médio de UMA análise. Quem roda
          várias análises no mês custa mais do que a coluna mostra; margem já negativa aqui é
          prejuízo certo.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-lg">Maiores consumidores</h2>
        <div className="overflow-x-auto rounded-2xl border border-neutro-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutro-50 text-left text-xs uppercase text-neutro-400">
              <tr>
                <th className="px-4 py-3">Organização</th>
                <th className="px-4 py-3">Chamadas</th>
                <th className="px-4 py-3">Custo</th>
                <th className="px-4 py-3">Créditos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutro-100">
              {consumidores.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-neutro-500">
                    Sem consumo de API no período.
                  </td>
                </tr>
              ) : (
                consumidores.map((c) => (
                  <tr key={c.organizationId} className="hover:bg-neutro-50">
                    <td className="px-4 py-3 font-medium text-marinho-700">{c.nome}</td>
                    <td className="px-4 py-3">{numeroBR(c.chamadas)}</td>
                    <td className="px-4 py-3">{brl(c.custoCents)}</td>
                    <td className="px-4 py-3">{numeroBR(c.creditos)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Section({
  title,
  cards,
}: {
  title: string;
  cards: { label: string; value: string; highlight?: boolean; warn?: boolean }[];
}) {
  return (
    <section>
      <h2 className="mb-3 text-lg">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className={`card p-5 ${c.highlight ? "border-marca-300" : ""}`}>
            <div className="text-xs uppercase tracking-wide text-neutro-400">{c.label}</div>
            <div className={`mt-2 text-2xl font-bold ${c.warn ? "text-alerta-700" : "text-marinho-700"}`}>
              {c.value}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
