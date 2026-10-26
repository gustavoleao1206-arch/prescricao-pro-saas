import Link from "next/link";
import { prisma } from "@/lib/db";
import { AnalysisStatusBadge } from "@/components/ui/badge";
import { AcoesDaAnalise } from "@/components/admin/analise-acoes";
import { dateBR, dateTimeBR } from "@/lib/format";
import { MINUTOS_SEM_SINAL_DE_VIDA, STATUS_EM_EXECUCAO, ultimoSinal } from "@/lib/analise-travada";
import {
  GRUPOS_DE_SITUACAO,
  grupoDaUrl,
  podeExecutar,
  type GrupoDeSituacao,
} from "@/lib/situacao-da-analise";
import { AnalysisStatus, Prisma } from "@prisma/client";

import { requireRole } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Análises de todos os clientes — a tela de trabalho do atendimento.
 *
 * ── O que ela era ────────────────────────────────────────────────────────────
 * Trinta e oito linhas de tabela somente-leitura: sem filtro, sem busca, sem ação, e com `take: 200`
 * fixo. Passando de duzentas análises, as mais antigas simplesmente não existiam para o atendimento — e
 * nada em tela dizia que a lista estava cortada. Diante de um cliente reclamando de uma análise presa, o
 * suporte não tinha como encontrá-la nem o que fazer com ela.
 *
 * ── O que ela é agora ─────────────────────────────────────────────────────────
 * Filtro por situação (abrindo em "precisam de atenção", que é onde estão os clientes esperando algo),
 * busca por cliente, título, número de processo e id, paginação com o total à vista, e as ações de
 * cancelar/arquivar/desarquivar/forçar status por linha.
 */

const POR_PAGINA = 50;

/**
 * Abas do atendimento. Abre em "atenção" de propósito: a fila que importa não é a lista completa, é a
 * das análises em erro ou aguardando informação — as únicas em que alguém está esperando por nós.
 */
const ABAS: GrupoDeSituacao[] = [
  "atencao",
  "processando",
  "revisao",
  "concluidas",
  "ativas",
  "canceladas",
  "arquivadas",
  "todas",
];

/** Rótulos em português para o seletor de "forçar status". */
const ROTULO_STATUS: Record<AnalysisStatus, string> = {
  RASCUNHO: "Rascunho",
  DOCUMENTOS_ENVIADOS: "Documentos enviados",
  VALIDANDO_DOCUMENTOS: "Validando documentos",
  EXTRAINDO_INFORMACOES: "Extraindo informações",
  PROCESSANDO: "Processando",
  AGUARDANDO_INFORMACOES: "Aguardando informações",
  AGUARDANDO_REVISAO: "Aguardando revisão",
  EM_REVISAO: "Em revisão",
  CONCLUIDA: "Concluída",
  ERRO_PROCESSAMENTO: "Erro de processamento",
  CANCELADA: "Cancelada",
  ARQUIVADA: "Arquivada",
};

/**
 * Destinos oferecidos em "forçar": tudo menos os status de EXECUÇÃO.
 *
 * Pôr uma análise em "Processando" à mão não faz motor nenhum rodar — ela ficaria assim até a varredura
 * de manutenção derrubá-la meia hora depois. O servidor recusa esses destinos; oferecê-los na tela seria
 * um caminho que existe só para dar erro. Ver `forcarSituacao`.
 */
const DESTINOS_POSSIVEIS = (Object.keys(ROTULO_STATUS) as AnalysisStatus[])
  .filter((s) => !STATUS_EM_EXECUCAO.includes(s))
  .map((s) => ({ valor: s, rotulo: ROTULO_STATUS[s] }));

export default async function AdminAnalisesPage({
  searchParams: searchParamsAsync,
}: {
  searchParams: Promise<{ situacao?: string; busca?: string; pagina?: string }>;
}) {
  /**
   * ⚠️ Guarda NO ARQUIVO, e não só no layout do grupo.
   *
   * A proteção desta área toda repousava num único redirecionamento no layout de `(admin)`. Isso funciona
   * enquanto ninguém criar página administrativa fora da pasta — e no dia em que criar, ela nasce sem
   * portão nenhum. Guarda escrita aqui é guarda; pasta certa é coincidência de organização.
   *
   * Hoje é redundância proposital: o layout já redirecionou antes de chegar aqui.
   */
  const admin = await requireRole("ADMIN");
  const searchParams = await searchParamsAsync;

  const grupo = grupoDaUrl(searchParams.situacao, "atencao");
  const busca = (searchParams.busca ?? "").trim();

  /**
   * ⚠️ Registra a BUSCA, porque buscar cliente por e-mail já é tratamento de dado pessoal.
   *
   * Este é o índice que torna a leitura irrestrita prática em vez de teórica: com ele, achar a análise de um
   * cliente pelo e-mail leva um campo de busca, e o link da linha abre o conteúdo completo. A busca é o passo
   * que antecede toda leitura indevida, e "quem procurou pelo cliente X" não tinha resposta.
   *
   * O termo vai para o metadata de propósito, e a decisão é consciente: ele pode conter e-mail de cliente, e
   * o saneamento por lista de bloqueio não cobre a chave `termoBuscado`. Sem o termo, o registro diria que
   * houve uma busca e não diria por quem — o que não serve para apurar nada. Só grava quando há termo: abrir
   * a tela para trabalhar na fila não é busca por pessoa.
   */
  if (busca) {
    await logAudit({
      actorId: admin.id,
      actorRole: "ADMIN",
      action: "admin.analysis.search",
      entityType: "Analysis",
      metadata: { termoBuscado: busca.slice(0, 120), grupo },
    });
  }
  /** `pagina` é entrada de quem navega: texto, zero e negativo caem em 1; o teto sai da contagem. */
  const paginaPedida = Math.max(1, Math.floor(Number(searchParams.pagina)) || 1);

  const status = GRUPOS_DE_SITUACAO[grupo].status;

  /**
   * A busca cobre o id de propósito: o suporte quase sempre chega com o link que o cliente colou, e o id
   * é o que existe naquele link. Sem isso, a única entrada seria o título — que o cliente raramente
   * lembra e às vezes nem escolheu.
   */
  const filtroBusca: Prisma.AnalysisWhereInput = busca
    ? {
        OR: [
          { id: busca },
          { title: { contains: busca, mode: "insensitive" } },
          { processNumber: { contains: busca, mode: "insensitive" } },
          { owner: { name: { contains: busca, mode: "insensitive" } } },
          { owner: { email: { contains: busca, mode: "insensitive" } } },
          { organization: { name: { contains: busca, mode: "insensitive" } } },
        ],
      }
    : {};

  const where: Prisma.AnalysisWhereInput = {
    ...(status ? { status: { in: status } } : {}),
    ...filtroBusca,
  };

  /**
   * O total vem PRIMEIRO para a página poder ser limitada ao que existe.
   *
   * Sem isso, `?pagina=999999` mostrava cabeçalho dizendo "página 999999 de 3" com a tabela vazia — o
   * que se lê como "não há análises" em vez de "você pediu uma página que não existe".
   */
  const total = await prisma.analysis.count({ where });
  const ultimaPagina = Math.max(1, Math.ceil(total / POR_PAGINA));
  const pagina = Math.min(paginaPedida, ultimaPagina);

  const [analyses, contagens] = await Promise.all([
    prisma.analysis.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (pagina - 1) * POR_PAGINA,
      take: POR_PAGINA,
      include: {
        owner: { select: { name: true, email: true } },
        organization: { select: { name: true } },
        _count: { select: { documents: true, reports: true } },
      },
    }),
    /**
     * ⚠️ A contagem das abas RESPEITA a busca, e a primeira versão não respeitava.
     *
     * Com o filtro de busca ativo, contar tudo fazia as abas prometerem números que a lista não
     * entregava: "Precisam de atenção (37)" com quatro linhas em tela. Quem tria fila confia no número
     * do rótulo para escolher onde clicar, e um número que não conversa com a lista faz a pessoa
     * concluir que a busca está quebrada.
     */
    prisma.analysis.groupBy({ by: ["status"], where: filtroBusca, _count: { _all: true } }),
  ]);

  const porGrupo = (g: GrupoDeSituacao) => {
    const lista = GRUPOS_DE_SITUACAO[g].status;
    return contagens.filter((c) => !lista || lista.includes(c.status)).reduce((s, c) => s + c._count._all, 0);
  };

  /**
   * Monta o link preservando os outros filtros.
   *
   * ⚠️ Só a PÁGINA é omitida quando vale 1. A primeira versão descartava todo valor igual a "1", o que
   * apagava silenciosamente uma busca pelo termo "1" — e número solto é justamente o que se digita ao
   * procurar por um processo. `URLSearchParams` já cuida de escapar o resto (E comercial, acento,
   * espaço), então busca com qualquer caractere sobrevive à paginação.
   */
  const linkCom = (mudanca: Record<string, string | undefined>) => {
    const atual: Record<string, string | undefined> = {
      situacao: grupo,
      busca: busca || undefined,
      pagina: pagina > 1 ? String(pagina) : undefined,
      ...mudanca,
    };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(atual)) {
      if (!v) continue;
      if (k === "pagina" && v === "1") continue;
      p.set(k, v);
    }
    const q = p.toString();
    return q ? `/admin/analises?${q}` : "/admin/analises";
  };

  const agora = new Date();

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl">Análises</h1>
        <p className="text-sm text-neutro-500">
          {total} {total === 1 ? "análise" : "análises"} em {GRUPOS_DE_SITUACAO[grupo].rotulo.toLowerCase()}
          {busca ? ` com “${busca}”` : ""} · página {pagina} de {ultimaPagina}
        </p>
      </div>

      <nav aria-label="Situação" className="mb-4 flex flex-wrap gap-2">
        {ABAS.map((g) => (
          <Link
            key={g}
            href={linkCom({ situacao: g, pagina: undefined })}
            aria-current={g === grupo ? "page" : undefined}
            className={`badge ${
              g === grupo ? "bg-marca-600 text-white" : "bg-neutro-100 text-neutro-600 hover:bg-neutro-200"
            }`}
          >
            {GRUPOS_DE_SITUACAO[g].rotulo} ({porGrupo(g)})
          </Link>
        ))}
      </nav>

      {/* Busca por GET: o filtro fica na URL, então dá para guardar e mandar o link a outra pessoa. */}
      <form method="get" action="/admin/analises" className="mb-6 flex flex-wrap gap-2">
        <input type="hidden" name="situacao" value={grupo} />
        <input
          name="busca"
          defaultValue={busca}
          placeholder="Cliente, e-mail, título, nº do processo ou id da análise"
          className="input min-w-[18rem] flex-1 text-sm"
          aria-label="Buscar análise"
        />
        <button type="submit" className="btn-outline text-sm">Buscar</button>
        {busca && (
          <Link href={linkCom({ busca: undefined, pagina: undefined })} className="btn-ghost text-sm">
            Limpar
          </Link>
        )}
      </form>

      <div className="overflow-x-auto rounded-2xl border border-neutro-200 bg-white dark:border-neutro-700 dark:bg-neutro-900">
        <table className="w-full text-sm">
          <thead className="bg-neutro-50 text-left text-xs uppercase text-neutro-400 dark:bg-neutro-800">
            <tr>
              <th className="px-4 py-3">Título</th>
              <th className="px-4 py-3">Cliente</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Criada</th>
              <th className="px-4 py-3">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutro-100 dark:divide-neutro-800">
            {analyses.map((a) => {
              /**
               * "Travada" é calculada com o MESMO critério da varredura de manutenção. É o sinal que o
               * atendimento precisa ver na lista: análise em processamento sem sinal de vida é cliente
               * com crédito preso, e antes isso só era visível abrindo a análise uma por uma.
               */
              const travada =
                STATUS_EM_EXECUCAO.includes(a.status) &&
                ultimoSinal(a).getTime() < agora.getTime() - MINUTOS_SEM_SINAL_DE_VIDA * 60_000;

              return (
                <tr key={a.id} className="align-top hover:bg-neutro-50 dark:hover:bg-neutro-800/50">
                  <td className="px-4 py-3">
                    {/* Leva à análise completa, que o ADMIN tem permissão de abrir. */}
                    <Link href={`/analises/${a.id}`} className="font-medium text-marca-600 hover:underline dark:text-marca-300">
                      {a.title}
                    </Link>
                    <div className="mt-0.5 text-xs text-neutro-400">
                      {a.processNumber ?? "sem nº"} · {a._count.documents} doc
                      {a._count.documents === 1 ? "" : "s"}
                      {a._count.reports > 0 ? ` · ${a._count.reports} relatório(s)` : " · sem relatório"}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-neutro-500">
                    {a.owner.name}
                    <div className="text-xs text-neutro-400">{a.organization.name}</div>
                  </td>
                  <td className="px-4 py-3">
                    <AnalysisStatusBadge status={a.status} />
                    {travada && (
                      <div className="mt-1 text-xs font-medium text-atencao">
                        travada desde {dateTimeBR(ultimoSinal(a))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-neutro-400">{dateBR(a.createdAt)}</td>
                  <td className="px-4 py-3">
                    <AcoesDaAnalise
                      id={a.id}
                      cliente={a.owner.name}
                      statusAtual={a.status}
                      /** Decidido no servidor, pela mesma função da rota — uma regra, um lugar. */
                      acoes={{
                        cancelar: podeExecutar("cancelar", a, agora).pode,
                        arquivar: podeExecutar("arquivar", a, agora).pode,
                        desarquivar: podeExecutar("desarquivar", a, agora).pode,
                      }}
                      statusPossiveis={DESTINOS_POSSIVEIS}
                    />
                  </td>
                </tr>
              );
            })}
            {analyses.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-neutro-500">
                  Nenhuma análise nesta situação{busca ? " com esse termo de busca" : ""}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {ultimaPagina > 1 && (
        <nav aria-label="Páginas" className="mt-4 flex items-center justify-between text-sm">
          {pagina > 1 ? (
            <Link href={linkCom({ pagina: String(pagina - 1) })} className="btn-outline">← Anteriores</Link>
          ) : (
            <span />
          )}
          <span className="text-neutro-500">
            {pagina} / {ultimaPagina}
          </span>
          {pagina < ultimaPagina ? (
            <Link href={linkCom({ pagina: String(pagina + 1) })} className="btn-outline">Próximas →</Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
