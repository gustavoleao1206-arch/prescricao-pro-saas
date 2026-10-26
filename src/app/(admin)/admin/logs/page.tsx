import { prisma } from "@/lib/db";
import { brl, dateTimeBR } from "@/lib/format";
import { ResolverPendencia } from "@/components/admin/resolver-pendencia";

export const dynamic = "force-dynamic";

/**
 * Registros do sistema — e, no topo, o dinheiro que espera uma decisão.
 *
 * ── Por que a lista de pagamentos pendentes mora aqui ─────────────────────────
 * Um pagamento que entra e não pode ser aplicado (conta apagada, plano fora do
 * catálogo, evento sem vínculo) ou que cai depois de um cancelamento fica gravado
 * com status PENDENTE e sem assinatura. Sem esta tabela, saber que ele existe
 * dependia de abrir o extrato do Asaas e conferir linha por linha. Ver
 * `dinheiroSemDestino`, em src/lib/asaas.ts.
 *
 * ── O detalhe do evento passou a aparecer ─────────────────────────────────────
 * A tabela de eventos de segurança mostrava tipo, e-mail, IP e data — e escondia
 * justamente o `metadata`, que é onde estão o id da cobrança, o valor e o motivo.
 * Quem abria a tela via "asaas_dinheiro_sem_destino" e não tinha como agir.
 */
const POR_PAGINA = 50;

export default async function AdminLogsPage({
  searchParams: searchParamsAsync,
}: {
  searchParams: Promise<{ item?: string; autor?: string; acao?: string; pagina?: string }>;
}) {
  const searchParams = await searchParamsAsync;
  /**
   * ⚠️ A TRILHA EXISTIA E NÃO ERA CONSULTÁVEL.
   *
   * A tabela mostrava ação, ator, tipo de entidade e data — e escondia o `entityId`. Ou seja, respondia
   * "houve um report.download" e não respondia "de qual cliente". Somado ao corte nas 100 últimas linhas sem
   * filtro, num dia de movimento a trilha rolava para fora da tela em horas, inclusive os registros de
   * download de documento sob sigilo, que são os que mais importam.
   *
   * O que passa a ser possível: um cliente ligar perguntando quem acessou o processo dele no mês passado, e a
   * pergunta ter resposta. É também de onde sai o "extrato de acessos" que a Política de Privacidade promete.
   *
   * Os filtros são baratos: `AuditLog` já tem índice em [entityType, entityId].
   */
  const item = (searchParams.item ?? "").trim();
  const autor = (searchParams.autor ?? "").trim();
  const acao = (searchParams.acao ?? "").trim();
  const pagina = Math.max(1, Math.floor(Number(searchParams.pagina)) || 1);

  const filtroAudit = {
    ...(item ? { entityId: item } : {}),
    ...(acao ? { action: { contains: acao, mode: "insensitive" as const } } : {}),
    ...(autor
      ? {
          actor: {
            OR: [
              { email: { contains: autor, mode: "insensitive" as const } },
              { name: { contains: autor, mode: "insensitive" as const } },
            ],
          },
        }
      : {}),
  };

  const [audit, totalAudit, security, pendentes, totalPendente] = await Promise.all([
    prisma.auditLog.findMany({
      where: filtroAudit,
      orderBy: { createdAt: "desc" },
      skip: (pagina - 1) * POR_PAGINA,
      take: POR_PAGINA,
      include: { actor: { select: { email: true } } },
    }),
    prisma.auditLog.count({ where: filtroAudit }),
    prisma.securityEvent.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.payment.findMany({
      where: { status: "PENDENTE" },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        subscription: {
          select: { id: true, status: true, organization: { select: { owner: { select: { email: true } } } } },
        },
      },
    }),
    /**
     * O total vem de uma agregação, não da soma das linhas exibidas.
     *
     * A lista é limitada a 50 para a tela não ficar impossível de ler. Somar só o que
     * está na tela fazia o total DISCORDAR do indicador do painel assim que houvesse a
     * 51ª pendência — e, num número que representa dinheiro a devolver, divergência
     * entre duas telas do mesmo sistema destrói a confiança nas duas.
     */
    prisma.payment.aggregate({ where: { status: "PENDENTE" }, _sum: { amountCents: true }, _count: { _all: true } }),
  ]);

  const somaPendente = totalPendente._sum.amountCents ?? 0;
  const naoExibidas = Math.max(0, totalPendente._count._all - pendentes.length);

  return (
    <div className="space-y-8">
      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl">Dinheiro sem destino</h1>
          {totalPendente._count._all > 0 && (
            <span className="text-sm font-semibold text-alerta-700">
              {brl(somaPendente)} aguardando decisão
              {naoExibidas > 0 ? ` (${naoExibidas} caso(s) além dos 50 exibidos)` : ""}
            </span>
          )}
        </div>
        <p className="mb-4 max-w-3xl text-sm text-neutro-500">
          Quantias que entraram no Asaas e <strong>não liberaram acesso a ninguém</strong>: pagamento que não pôde ser
          vinculado a uma conta, ou cobrança recebida depois de um cancelamento. Cada linha exige uma decisão —
          identificar o pagador e liberar o acesso à mão, ou devolver a quantia no painel do Asaas. Devolvendo pelo
          Asaas, a linha sai daqui sozinha; nos outros casos, use <strong>Encerrar caso</strong>.
        </p>
        <div className="overflow-x-auto rounded-2xl border border-neutro-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutro-50 text-left text-xs uppercase text-neutro-400">
              <tr>
                <th className="px-4 py-3">Valor</th>
                <th className="px-4 py-3">Cobrança no Asaas</th>
                <th className="px-4 py-3">Forma</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Entrou em</th>
                <th className="px-4 py-3">Decisão</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutro-100">
              {pendentes.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-3 font-semibold text-alerta-700">{brl(p.amountCents)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-neutro-500">{p.externalId ?? "-"}</td>
                  <td className="px-4 py-3 text-neutro-500">{p.method ?? "-"}</td>
                  <td className="px-4 py-3 text-neutro-500">
                    {p.subscription?.organization?.owner?.email ?? (
                      <span className="text-alerta-700">não identificado</span>
                    )}
                    {p.subscription && (
                      <span className="ml-1 text-xs text-neutro-400">({p.subscription.status})</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-neutro-400">{dateTimeBR(p.createdAt)}</td>
                  <td className="px-4 py-3">
                    <ResolverPendencia id={p.id} valor={brl(p.amountCents)} />
                  </td>
                </tr>
              ))}
              {pendentes.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-neutro-500">
                    Nenhuma quantia pendente. Todo dinheiro que entrou tem destino.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-xl">Auditoria</h2>
        <p className="mb-4 max-w-3xl text-sm text-neutro-500">
          Quem fez o quê, e <strong>em qual item</strong>. Para responder &quot;quem acessou o processo deste
          cliente&quot;, cole o id da análise em <strong>Item</strong>; para &quot;o que esta pessoa
          acessou&quot;, use <strong>Autor</strong>.
        </p>

        {/* Busca por GET: o endereço da tela fica compartilhável e volta ao mesmo resultado. */}
        <form method="get" action="/admin/logs" className="mb-4 flex flex-wrap items-end gap-2">
          <label className="text-xs text-neutro-500">
            Item acessado (id)
            <input name="item" defaultValue={item} placeholder="id da análise, documento…" className="input mt-1 w-64 font-mono text-xs" />
          </label>
          <label className="text-xs text-neutro-500">
            Autor (nome ou e-mail)
            <input name="autor" defaultValue={autor} placeholder="quem acessou" className="input mt-1 w-56" />
          </label>
          <label className="text-xs text-neutro-500">
            Ação
            <input name="acao" defaultValue={acao} placeholder="analysis.view, report.download…" className="input mt-1 w-56" />
          </label>
          <button type="submit" className="btn-outline text-sm">Filtrar</button>
          {(item || autor || acao) && (
            <a href="/admin/logs" className="text-sm text-neutro-500 underline">limpar</a>
          )}
        </form>

        <div className="overflow-x-auto rounded-2xl border border-neutro-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutro-50 text-left text-xs uppercase text-neutro-400">
              <tr>
                <th className="px-4 py-3">Ação</th>
                <th className="px-4 py-3">Ator</th>
                <th className="px-4 py-3">Papel</th>
                <th className="px-4 py-3">Item acessado</th>
                <th className="px-4 py-3">Detalhe</th>
                <th className="px-4 py-3">Quando</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutro-100">
              {audit.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-3 font-medium text-marinho-700">{l.action}</td>
                  <td className="px-4 py-3 text-neutro-500">{l.actor?.email ?? "sistema"}</td>
                  <td className="px-4 py-3 text-neutro-500">{l.actorRole ?? "-"}</td>
                  {/*
                    O id é o que responde "de qual cliente". Vira link para filtrar por ele: o caso de uso
                    real é "quero TODOS os acessos a este item", e ninguém quer copiar id à mão.
                  */}
                  <td className="px-4 py-3 font-mono text-xs text-neutro-500">
                    {l.entityId ? (
                      <a href={`/admin/logs?item=${encodeURIComponent(l.entityId)}`} className="underline">
                        {l.entityType ? `${l.entityType} ` : ""}
                        {l.entityId}
                      </a>
                    ) : (
                      (l.entityType ?? "-")
                    )}
                  </td>
                  <td className="max-w-sm break-words px-4 py-3 font-mono text-xs text-neutro-500">
                    {detalhe(l.metadata)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-neutro-400">{dateTimeBR(l.createdAt)}</td>
                </tr>
              ))}
              {audit.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-neutro-500">Sem registros para este filtro.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Paginação: sem ela, a trilha de um dia movimentado rolava para fora da tela em horas. */}
        <div className="mt-3 flex items-center justify-between text-sm text-neutro-500">
          <span>
            {totalAudit} registro(s)
            {totalAudit > POR_PAGINA ? ` · página ${pagina} de ${Math.ceil(totalAudit / POR_PAGINA)}` : ""}
          </span>
          <span className="flex gap-3">
            {pagina > 1 && (
              <a href={paginaComFiltro({ item, autor, acao }, pagina - 1)} className="underline">anterior</a>
            )}
            {pagina * POR_PAGINA < totalAudit && (
              <a href={paginaComFiltro({ item, autor, acao }, pagina + 1)} className="underline">próxima</a>
            )}
          </span>
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-xl">Eventos de segurança</h2>
        <div className="overflow-x-auto rounded-2xl border border-neutro-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutro-50 text-left text-xs uppercase text-neutro-400">
              <tr>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">E-mail</th>
                <th className="px-4 py-3">IP</th>
                <th className="px-4 py-3">Detalhe</th>
                <th className="px-4 py-3">Quando</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutro-100">
              {security.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-3 font-medium text-alerta-700">{s.type}</td>
                  <td className="px-4 py-3 text-neutro-500">{s.email ?? "-"}</td>
                  <td className="px-4 py-3 text-neutro-500">{s.ip ?? "-"}</td>
                  {/*
                    O detalhe é o que torna o evento acionável: id da cobrança, valor,
                    motivo. Quebra em qualquer largura para o id não empurrar a tabela.
                  */}
                  <td className="max-w-md break-words px-4 py-3 font-mono text-xs text-neutro-500">
                    {detalhe(s.metadata)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-neutro-400">{dateTimeBR(s.createdAt)}</td>
                </tr>
              ))}
              {security.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-neutro-500">Sem eventos.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** Mantém os filtros ao trocar de página — perder o filtro na paginação é o defeito clássico daqui. */
function paginaComFiltro(f: { item: string; autor: string; acao: string }, pagina: number): string {
  const p = new URLSearchParams();
  if (f.item) p.set("item", f.item);
  if (f.autor) p.set("autor", f.autor);
  if (f.acao) p.set("acao", f.acao);
  if (pagina > 1) p.set("pagina", String(pagina));
  const q = p.toString();
  return q ? `/admin/logs?${q}` : "/admin/logs";
}

/** `metadata` em uma linha legível, sem virar parede de JSON. */
function detalhe(metadata: unknown): string {
  if (metadata === null || typeof metadata !== "object") return "-";
  const partes = Object.entries(metadata as Record<string, unknown>)
    // `source` é sempre "asaas" nos eventos de pagamento: ocupa espaço e não informa.
    .filter(([chave, valor]) => chave !== "source" && valor !== null && valor !== undefined && valor !== "")
    .map(([chave, valor]) => `${chave}: ${typeof valor === "object" ? JSON.stringify(valor) : String(valor)}`);
  return partes.length ? partes.join(" · ") : "-";
}
