import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { carregarChamado, ehEquipe } from "@/lib/support";
import { SupportThread, type MensagemChamado } from "@/components/app/support-thread";
import { dateBR } from "@/lib/format";

export const dynamic = "force-dynamic";

const ROTULO_STATUS: Record<string, string> = {
  ABERTO: "Aberto",
  EM_ATENDIMENTO: "Em atendimento",
  AGUARDANDO_CLIENTE: "Aguardando você",
  RESOLVIDO: "Resolvido",
  ENCERRADO: "Encerrado",
};

/**
 * Detalhe do chamado na visão do cliente.
 *
 * O isolamento é feito em `carregarChamado`, que devolve null quando o chamado
 * é de outra pessoa — e aqui isso vira 404, sem revelar que o chamado existe.
 */
export default async function ChamadoPage({ params: paramsAsync }: { params: Promise<{ id: string }> }) {
  const params = await paramsAsync;
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const ticket = await carregarChamado(params.id, user);
  if (!ticket) notFound();

  const mensagens: MensagemChamado[] = ticket.messages.map((m) => ({
    id: m.id,
    body: m.body,
    createdAt: dateBR(m.createdAt),
    autorNome: ehEquipe(m.author.role) ? "Suporte Prescrição Pro" : m.author.name,
    daEquipe: ehEquipe(m.author.role),
  }));

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/suporte" className="text-sm font-medium text-marca-600 hover:underline dark:text-marca-300">
        ← Meus chamados
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
        <p className="mt-2 text-sm text-neutro-500">Aberto em {dateBR(ticket.createdAt)}</p>
      </header>

      <SupportThread
        ticketId={ticket.id}
        numero={ticket.number}
        status={ticket.status}
        mensagens={mensagens}
      />
    </div>
  );
}
