import Link from "next/link";
import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { AnalysisStatusBadge, SubscriptionStatusBadge } from "@/components/ui/badge";
import { dateBR } from "@/lib/format";
import { saldoDe } from "@/lib/credits";
import { renovacaoDe } from "@/lib/renovacao";

export const dynamic = "force-dynamic";

export default async function PainelPage() {
  const ctx = await getAppContext();
  if (!ctx) redirect("/login");
  const { user, organization, currentSubscription, access } = ctx;

  const orgId = organization?.id;
  const [recent, processing, plan] = await Promise.all([
    orgId
      ? prisma.analysis.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "desc" }, take: 5 })
      : Promise.resolve([]),
    orgId
      ? prisma.analysis.count({ where: { organizationId: orgId, status: { in: ["PROCESSANDO", "VALIDANDO_DOCUMENTOS", "EXTRAINDO_INFORMACOES", "AGUARDANDO_REVISAO", "EM_REVISAO"] } } })
      : Promise.resolve(0),
    currentSubscription ? prisma.plan.findUnique({ where: { id: currentSubscription.planId } }) : Promise.resolve(null),
  ]);

  const saldo = saldoDe(currentSubscription);
  const semSaldo = !saldo.ilimitado && saldo.total === 0;

  /**
   * Como esta assinatura continua — e como se fala disso.
   *
   * O cartão daqui era fixo em "Próxima renovação", com a data caindo para o fim do
   * período quando não havia renovação nenhuma. O cliente de PIX (cobrança única, sem
   * mandato de débito) e o que acabou de CANCELAR liam os dois uma renovação prometida
   * que nunca viria. Ver src/lib/renovacao.ts.
   */
  const renovacao = renovacaoDe(currentSubscription, { emTolerancia: access.inGracePeriod });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl">Olá, {user.name.split(" ")[0]} 👋</h1>
        <p className="mt-1 text-sm text-neutro-500">Bem-vindo(a) ao seu painel do Prescrição Pro.</p>
      </div>

      {!currentSubscription && (
        <div className="rounded-2xl border border-atencao-100 bg-atencao-50 p-5 text-sm text-atencao">
          Você ainda não possui uma assinatura ativa.{" "}
          <Link href="/planos" className="font-semibold underline">Escolha um plano</Link> para iniciar análises.
        </div>
      )}

      {/* Pendência de pagamento dentro da tolerância: o acesso continua, mas o
          cliente precisa saber que há prazo. */}
      {access.inGracePeriod && (
        <div className="rounded-2xl border border-atencao-100 bg-atencao-50 p-5 text-sm text-atencao">
          <p className="font-semibold">{access.message}</p>
          <Link href="/assinatura" className="mt-2 inline-block font-semibold underline">
            Regularizar pagamento
          </Link>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Plano atual"
          value={plan?.name ?? "-"}
          extra={currentSubscription && <SubscriptionStatusBadge status={currentSubscription.status} />}
        />
        <Stat
          label="Créditos disponíveis"
          value={saldo.ilimitado ? "Sem limite" : String(saldo.total)}
          rodape={
            saldo.ilimitado
              ? undefined
              : saldo.saldoAdicional > 0
                ? `${saldo.saldoMensal} do plano + ${saldo.saldoAdicional} adicionais`
                : undefined
          }
        />
        <Stat
          label={renovacao.rotuloDaData}
          value={dateBR(renovacao.data)}
          rodape={currentSubscription ? renovacao.formaDeCobranca : undefined}
        />
        <Stat label="Em processamento" value={String(processing)} />
      </div>

      {/* Barra de consumo do ciclo. Só faz sentido em plano com cota. */}
      {currentSubscription && !saldo.ilimitado && saldo.cotaMensal > 0 && (
        <section className="card p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-marinho-700">Consumo deste ciclo</h2>
            <span className="text-sm text-neutro-600">
              {saldo.usadosNoCiclo} {saldo.usadosNoCiclo === 1 ? "análise utilizada" : "análises utilizadas"} de {saldo.cotaMensal}
            </span>
          </div>
          <BarraConsumo usados={saldo.usadosNoCiclo} total={saldo.cotaMensal} />
          <p className="mt-2 text-xs text-neutro-500">
            {/*
              "Renovados a cada ciclo" pressupõe um ciclo seguinte. No pagamento único não
              existe: o saldo acaba com o período, e prometer renovação faria o cliente
              esperar por algo que não vem.
            */}
            {renovacao.temProximoCiclo
              ? "Os créditos do plano são renovados a cada ciclo e não acumulam."
              : "Os créditos do plano valem até o fim do período contratado e não acumulam."}
            {saldo.saldoAdicional > 0 &&
              ` Você tem ainda ${saldo.saldoAdicional} ${saldo.saldoAdicional === 1 ? "crédito adicional" : "créditos adicionais"}, com validade própria.`}
          </p>
        </section>
      )}

      {/* Saldo zerado: as três saídas que a especificação exige, no lugar onde
          o cliente percebe o problema. */}
      {semSaldo && currentSubscription && (
        <div className="rounded-2xl border border-atencao-100 bg-atencao-50 p-5">
          <p className="text-sm font-medium text-atencao">
            Você utilizou todas as análises disponíveis no seu plano. Compre créditos adicionais, faça upgrade
            {renovacao.temProximoCiclo
              ? " ou aguarde a próxima renovação para continuar."
              : " ou contrate um novo período para continuar."}
          </p>
          {/*
            Sem acesso, comprar crédito não resolve nada: o crédito complementa uma
            assinatura ativa, e o gate recusa a análise antes de olhar saldo. O botão
            principal muda conforme o caso, senão o cliente paga R$ 5,00 para descobrir
            que continua barrado.
          */}
          <div className="mt-4 flex flex-wrap gap-2">
            {access.hasAccess ? (
              <Link href="/assinatura#creditos" className="btn-primary text-sm">Comprar créditos</Link>
            ) : (
              <Link href="/planos" className="btn-primary text-sm">Reativar assinatura</Link>
            )}
            <Link href="/planos" className="btn-outline text-sm">Fazer upgrade</Link>
            <Link href="/assinatura" className="btn-ghost text-sm">
              {renovacao.temProximoCiclo ? "Ver data da renovação" : "Ver minha assinatura"}
            </Link>
          </div>
        </div>
      )}

      {/*
        A barra de sete atalhos saiu daqui a pedido do dono: a navegação da área
        do cliente é o menu lateral, e repetir os mesmos destinos em botões no
        topo do painel duplicava o menu na horizontal.

        Todos os destinos continuam a um clique pela lateral — Nova análise,
        Minhas análises, Créditos, Assinatura e Configurações —, e "Comprar
        créditos" é uma seção dentro de Assinatura.

        A ÚNICA exceção está registrada para quem for mexer aqui: "Fazer upgrade"
        levava a /planos, e a página de Assinatura só mostra esse caminho para
        quem precisa assinar, regularizar ou reativar. Assinante em dia, portanto,
        deixou de ter link para trocar de mensal para anual dentro do sistema.
      */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg">Análises recentes</h2>
          <Link href="/analises" className="text-sm text-marinho-600 hover:underline">Ver todas</Link>
        </div>
        <div className="card divide-y divide-neutro-100">
          {recent.length === 0 ? (
            <p className="p-6 text-sm text-neutro-500">Nenhuma análise ainda. Comece pela sua primeira análise.</p>
          ) : (
            recent.map((a) => (
              <Link key={a.id} href={`/analises/${a.id}`} className="flex items-center justify-between gap-4 p-4 hover:bg-neutro-50">
                <div className="min-w-0">
                  <div className="truncate font-medium text-marinho-700">{a.title}</div>
                  <div className="text-xs text-neutro-400">
                    {a.processNumber ?? "sem nº"} · {dateBR(a.createdAt)}
                    {a.creditsCharged > 0 && ` · ${a.creditsCharged} ${a.creditsCharged === 1 ? "crédito" : "créditos"}`}
                  </div>
                </div>
                <AnalysisStatusBadge status={a.status} />
              </Link>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function BarraConsumo({ usados, total }: { usados: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((usados / total) * 100)) : 0;
  // Amarelo a partir de 75% e vermelho no esgotamento: o cliente enxerga que
  // está no fim antes de esbarrar no bloqueio.
  const cor = pct >= 100 ? "bg-alerta-500" : pct >= 75 ? "bg-atencao" : "grad-marca";
  return (
    <div
      className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-neutro-200"
      role="progressbar"
      aria-valuenow={usados}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={`${usados} de ${total} créditos utilizados`}
    >
      <div className={`h-full rounded-full transition-all ${cor}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Stat({ label, value, extra, rodape }: { label: string; value: string; extra?: React.ReactNode; rodape?: string }) {
  return (
    <div className="card p-5">
      <div className="text-xs font-medium uppercase tracking-wide text-neutro-400">{label}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xl font-bold text-marinho-700">{value}</span>
        {extra}
      </div>
      {rodape && <div className="mt-1 text-xs text-neutro-500">{rodape}</div>}
    </div>
  );
}
