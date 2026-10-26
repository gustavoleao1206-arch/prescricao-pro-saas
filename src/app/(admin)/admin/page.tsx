import Link from "next/link";
import { prisma } from "@/lib/db";
import { brl, dateBR } from "@/lib/format";
import { contarPedidosEmAberto } from "@/lib/pedido-do-titular";

export const dynamic = "force-dynamic";

export default async function AdminDashboard() {
  /**
   * Falha de banco NÃO pode virar zero na tela.
   *
   * A versão anterior terminava a consulta com `.catch(() => [0, [], ...])`:
   * qualquer erro de banco era engolido e o painel exibia "0 com erro / 0
   * chamados abertos / 0 falhas de pagamento". Ou seja, falha de leitura e
   * negócio saudável ficavam visualmente IDÊNTICOS — o pior tipo de defeito num
   * painel, porque induz a decisão errada com aparência de normalidade.
   *
   * Agora o erro é capturado, registrado e EXIBIDO, e os números não são
   * renderizados como se fossem verdade.
   */
  let erroLeitura: string | null = null;
  const [
    clientes,
    subByStatus,
    mrrAgg,
    paymentFailures,
    aiTokens,
    analysesTotal,
    awaitingReview,
    analysesError,
    eventosDeSeguranca,
    openTickets,
    securityAlerts,
    recentAudit,
    dinheiroPendente,
    pedidosDeExclusao,
  ] = await Promise.all([
    prisma.user.count({ where: { role: "CLIENTE" } }),
    prisma.subscription.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.subscription.aggregate({ where: { status: "ATIVA" }, _sum: { amountCents: true } }),
    prisma.payment.count({ where: { status: { in: ["RECUSADO", "ESTORNADO", "CHARGEBACK"] } } }),
    prisma.consumptionRecord.aggregate({ _sum: { aiInputTokens: true, aiOutputTokens: true } }),
    prisma.analysis.count(),
    prisma.analysis.count({ where: { status: "AGUARDANDO_REVISAO" } }),
    prisma.analysis.count({ where: { status: "ERRO_PROCESSAMENTO" } }),
    prisma.securityEvent.groupBy({ by: ["type"], _count: { _all: true } }),
    prisma.supportTicket.count({ where: { status: { in: ["ABERTO", "EM_ATENDIMENTO"] } } }),
    prisma.securityEvent.count(),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
    /**
     * Dinheiro que entrou e ainda não tem destino.
     *
     * `Payment` com status PENDENTE é usado para uma coisa só: quantia recebida no
     * Asaas que não pôde ser aplicada a ninguém, ou que caiu depois de um
     * cancelamento e tem de ser devolvida. Por isso a soma é exata, e é o número
     * mais urgente desta tela — cada real aqui é alguém sem o que pagou.
     */
    prisma.payment.aggregate({ where: { status: "PENDENTE" }, _sum: { amountCents: true }, _count: { _all: true } }),
    /**
     * Pedido de exclusão do titular ainda não executado. Vem da MESMA função que a
     * varredura noturna usa (`pedidosEmAberto`), porque tela e alerta discordando sobre o
     * que é pendência destrói a confiança nos dois números.
     */
    contarPedidosEmAberto(),
  ]).catch((err) => {
    erroLeitura = (err as Error).message;
    console.error("[admin] falha ao carregar indicadores do painel:", erroLeitura);
    return [0, [], { _sum: {} }, 0, { _sum: {} }, 0, 0, 0, [], 0, 0, [], { _sum: {}, _count: { _all: 0 } }, 0] as never;
  });

  const subCount = (s: string) => (subByStatus as { status: string; _count: { _all: number } }[]).find((b) => b.status === s)?._count._all ?? 0;
  /**
   * Contagem por tipo de evento de segurança.
   *
   * Substituiu o painel de eventos da Hotmart, que saiu com a integração. Não é
   * uma troca cosmética: as pendências abaixo são gravadas por
   * `logSecurityEvent` quando algo dá errado com DINHEIRO — cobrança que não foi
   * cancelada, recorrência que ficou no valor antigo, pagamento que chegou sem
   * destino — e até aqui não existia tela nenhuma mostrando isso. Ficavam numa
   * tabela que ninguém abre.
   */
  const eventos = (nome: string) =>
    (eventosDeSeguranca as { type: string; _count: { _all: number } }[]).find((e) => e.type === nome)?._count._all ?? 0;
  const mrr = (mrrAgg as { _sum: { amountCents: number | null } })._sum.amountCents ?? 0;
  const tokens = ((aiTokens as { _sum: { aiInputTokens: number | null; aiOutputTokens: number | null } })._sum.aiInputTokens ?? 0) + ((aiTokens as { _sum: { aiOutputTokens: number | null } })._sum.aiOutputTokens ?? 0);

  const financeiro = [
    { label: "MRR (recorrente/mês)", value: brl(mrr), highlight: true },
    { label: "Clientes", value: clientes },
    { label: "Assinantes ativos", value: subCount("ATIVA") },
    { label: "Inadimplentes", value: subCount("INADIMPLENTE"), warn: subCount("INADIMPLENTE") > 0 },
    { label: "Suspensas", value: subCount("SUSPENSA"), warn: subCount("SUSPENSA") > 0 },
    { label: "Canceladas", value: subCount("CANCELADA") },
    { label: "Falhas de pagamento", value: paymentFailures, warn: paymentFailures > 0 },
    { label: "Tokens de IA (consumo)", value: tokens.toLocaleString("pt-BR") },
  ];

  const operacao = [
    { label: "Análises (total)", value: analysesTotal },
    { label: "Aguardando revisão", value: awaitingReview },
    { label: "Com erro", value: analysesError, warn: (analysesError as number) > 0 },
    { label: "Chamados abertos", value: openTickets },
    /**
     * Pedido de exclusão do titular ainda não executado.
     *
     * Fica NA TELA, e não só no alerta noturno, porque é prazo legal correndo: a Política
     * publica resposta e execução em 15 dias (art. 19, II, da LGPD), e o alerta sai uma vez
     * por etapa para não virar ruído. Quem abre este painel de manhã precisa ver o número
     * sem depender de ter lido o e-mail da madrugada. Ver `vigiarPrazosDoTitular`.
     */
    {
      label: "Exclusão pedida (LGPD)",
      value: pedidosDeExclusao,
      warn: (pedidosDeExclusao as number) > 0,
    },
  ];

  // Cada linha aqui é um cliente com problema de cobrança esperando alguém agir.
  const pendente = dinheiroPendente as { _sum: { amountCents: number | null }; _count: { _all: number } };
  const valorPendente = pendente._sum.amountCents ?? 0;
  const qtdPendente = pendente._count._all;
  const webhooks = [
    /**
     * O valor vem antes da contagem de eventos porque é o que exige ação hoje: é
     * dinheiro no Asaas que não virou acesso para ninguém. Ver `dinheiroSemDestino`.
     */
    { label: `Dinheiro sem destino (${qtdPendente})`, value: brl(valorPendente), warn: valorPendente > 0 },
    { label: "Cobrança após cancelamento", value: eventos("asaas_cobranca_apos_cancelamento"), warn: eventos("asaas_cobranca_apos_cancelamento") > 0 },
    { label: "Cobrança dupla pendente", value: eventos("asaas_cobranca_anterior_ativa"), warn: eventos("asaas_cobranca_anterior_ativa") > 0 },
    { label: "Cancelamento não efetivado", value: eventos("asaas_cancelamento_nao_efetivado"), warn: eventos("asaas_cancelamento_nao_efetivado") > 0 },
    { label: "Recorrência no valor antigo", value: eventos("asaas_recorrencia_desatualizada"), warn: eventos("asaas_recorrencia_desatualizada") > 0 },
    { label: "Webhook recusado", value: eventos("webhook_invalid"), warn: eventos("webhook_invalid") > 0 },
    { label: "Eventos de segurança (total)", value: securityAlerts },
  ];

  return (
    <div className="space-y-8">
      <h1 className="text-2xl">Visão geral</h1>

      {erroLeitura && (
        <div className="rounded-2xl border border-atencao-100 bg-atencao-50 p-4 dark:border-atencao/40 dark:bg-atencao/10">
          <p className="font-semibold text-atencao">Não foi possível ler os indicadores do banco de dados.</p>
          <p className="mt-1 text-sm text-atencao">
            <strong>Os números abaixo não são confiáveis</strong> — trate-os como indisponíveis, não como zero.
            Recarregue a página; se persistir, verifique o banco antes de tomar qualquer decisão com base nesta tela.
          </p>
          <p className="mt-2 font-mono text-xs text-neutro-500">{erroLeitura}</p>
        </div>
      )}

      <Section title="Assinaturas e receita" cards={financeiro} />
      <Section title="Operação" cards={operacao} />

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg">Pagamento — pendências que exigem ação</h2>
          <Link href="/admin/logs" className="text-sm text-marinho-600 hover:underline">Ver os eventos →</Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {webhooks.map((c) => (
            <Card key={c.label} label={c.label} value={c.value} warn={c.warn} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg">Atividade recente (auditoria)</h2>
        <div className="card divide-y divide-neutro-100">
          {(recentAudit as { id: string; action: string; entityType: string | null; createdAt: Date }[]).length === 0 ? (
            <p className="p-5 text-sm text-neutro-500">Sem registros ainda.</p>
          ) : (
            (recentAudit as { id: string; action: string; entityType: string | null; createdAt: Date }[]).map((log) => (
              <div key={log.id} className="flex items-center justify-between gap-3 p-4 text-sm">
                <span className="font-medium text-marinho-700">{log.action}</span>
                <span className="text-xs text-neutro-400">{log.entityType ?? ""} · {dateBR(log.createdAt)}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function Section({ title, cards }: { title: string; cards: { label: string; value: string | number; highlight?: boolean; warn?: boolean }[] }) {
  return (
    <section>
      <h2 className="mb-3 text-lg">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label} label={c.label} value={c.value} highlight={c.highlight} warn={c.warn} />
        ))}
      </div>
    </section>
  );
}

function Card({ label, value, highlight, warn }: { label: string; value: string | number; highlight?: boolean; warn?: boolean }) {
  return (
    <div className={`card p-5 ${highlight ? "border-marca-300" : ""}`}>
      <div className="text-xs uppercase tracking-wide text-neutro-400">{label}</div>
      <div className={`mt-2 text-2xl font-bold ${warn ? "text-alerta-700" : "text-marinho-700"}`}>{value}</div>
    </div>
  );
}
