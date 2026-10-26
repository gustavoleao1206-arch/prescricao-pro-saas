import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { carregarChamado, ehEquipe } from "@/lib/support";
import { SupportThread, type MensagemChamado } from "@/components/app/support-thread";
import { dateBR } from "@/lib/format";

export const dynamic = "force-dynamic";

const ROTULO_STATUS: Record<string, string> = {
  ABERTO: "Aberto",
  EM_ATENDIMENTO: "Em atendimento",
  AGUARDANDO_CLIENTE: "Aguardando cliente",
  RESOLVIDO: "Resolvido",
  ENCERRADO: "Encerrado",
};

/**
 * Detalhe do chamado na visão da equipe.
 *
 * Esta página existe porque antes o admin via apenas a CONTAGEM de mensagens na
 * listagem — não havia nenhuma tela, em nenhum lugar do sistema, que mostrasse o
 * texto escrito pelo cliente. Para saber do que se tratava o chamado era preciso
 * abrir o banco de dados.
 */
export default async function AdminChamadoPage({ params: paramsAsync }: { params: Promise<{ id: string }> }) {
  const params = await paramsAsync;
  const user = await requireRole("ADMIN", "SUPORTE");
  const ticket = await carregarChamado(params.id, user);
  if (!ticket) notFound();

  const mensagens: MensagemChamado[] = ticket.messages.map((m) => ({
    id: m.id,
    body: m.body,
    createdAt: dateBR(m.createdAt),
    autorNome: m.author.name,
    daEquipe: ehEquipe(m.author.role),
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/admin/suporte" className="text-sm font-medium text-marca-600 hover:underline dark:text-marca-300">
        ← Todos os chamados
      </Link>

      <header className="mb-6 mt-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl">
            #{ticket.number} · {ticket.subject}
          </h1>
          <span className="badge bg-marca-50 text-marca-700 dark:bg-marca-500/20 dark:text-marca-200">
            {ROTULO_STATUS[ticket.status] ?? ticket.status}
          </span>
        </div>
        <dl className="mt-3 grid gap-x-8 gap-y-1 text-sm text-neutro-500 sm:grid-cols-2">
          <div>
            <dt className="inline font-medium text-neutro-600 dark:text-neutro-300">Cliente: </dt>
            <dd className="inline">
              {ticket.requester.name} · {ticket.requester.email}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium text-neutro-600 dark:text-neutro-300">Prioridade: </dt>
            <dd className="inline">{ticket.priority}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-neutro-600 dark:text-neutro-300">Aberto em: </dt>
            <dd className="inline">{dateBR(ticket.createdAt)}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-neutro-600 dark:text-neutro-300">Responsável: </dt>
            <dd className="inline">{ticket.agent?.name ?? "—"}</dd>
          </div>
          {ticket.category && (
            <div>
              <dt className="inline font-medium text-neutro-600 dark:text-neutro-300">Categoria: </dt>
              <dd className="inline">{ticket.category}</dd>
            </div>
          )}
          {ticket.resolvedAt && (
            <div>
              <dt className="inline font-medium text-neutro-600 dark:text-neutro-300">Resolvido em: </dt>
              <dd className="inline">{dateBR(ticket.resolvedAt)}</dd>
            </div>
          )}
        </dl>
      </header>

      <SupportThread
        ticketId={ticket.id}
        numero={ticket.number}
        status={ticket.status}
        mensagens={mensagens}
        equipe
      />
    </div>
  );
}
