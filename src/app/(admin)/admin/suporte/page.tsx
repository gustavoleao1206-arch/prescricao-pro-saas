import Link from "next/link";
import { prisma } from "@/lib/db";
import { dateBR } from "@/lib/format";

export const dynamic = "force-dynamic";

const ROTULO_STATUS: Record<string, string> = {
  ABERTO: "Aberto",
  EM_ATENDIMENTO: "Em atendimento",
  AGUARDANDO_CLIENTE: "Aguardando cliente",
  RESOLVIDO: "Resolvido",
  ENCERRADO: "Encerrado",
};

/** Chamados que ainda esperam ação da equipe (o cliente respondeu ou nem foi atendido). */
const PENDENTES = new Set(["ABERTO", "EM_ATENDIMENTO"]);

export default async function AdminSuportePage() {
  const tickets = await prisma.supportTicket.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
    include: {
      requester: { select: { name: true, email: true } },
      agent: { select: { name: true } },
      _count: { select: { messages: true } },
    },
  });

  const pendentes = tickets.filter((t) => PENDENTES.has(t.status)).length;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl">Chamados de suporte ({tickets.length})</h1>
        {pendentes > 0 && (
          <span className="badge bg-atencao-50 text-atencao">
            {pendentes} aguardando você
          </span>
        )}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-neutro-200 bg-white dark:border-neutro-700 dark:bg-neutro-900">
        <table className="w-full text-sm">
          <thead className="bg-neutro-50 text-left text-xs uppercase text-neutro-400 dark:bg-neutro-800">
            <tr>
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Assunto</th>
              <th className="px-4 py-3">Cliente</th>
              <th className="px-4 py-3">Prioridade</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Responsável</th>
              <th className="px-4 py-3">Aberto</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutro-100 dark:divide-neutro-800">
            {tickets.map((t) => (
              <tr key={t.id} className="hover:bg-neutro-50 dark:hover:bg-neutro-800/50">
                <td className="px-4 py-3 text-neutro-500">{t.number}</td>
                <td className="px-4 py-3">
                  {/* A linha precisa levar ao chamado: antes a tabela era inerte e
                      não havia nenhum caminho para ler ou responder. */}
                  <Link
                    href={`/admin/suporte/${t.id}`}
                    className="font-medium text-marca-600 hover:underline dark:text-marca-300"
                  >
                    {t.subject}
                  </Link>
                  <span className="ml-2 text-xs text-neutro-400">
                    {t._count.messages} mensagem{t._count.messages === 1 ? "" : "s"}
                  </span>
                </td>
                <td className="px-4 py-3 text-neutro-500">{t.requester.name}</td>
                <td className="px-4 py-3">{t.priority}</td>
                <td className="px-4 py-3">
                  <span className={PENDENTES.has(t.status) ? "font-medium text-atencao" : "text-neutro-500"}>
                    {ROTULO_STATUS[t.status] ?? t.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-neutro-400">{t.agent?.name ?? "—"}</td>
                <td className="px-4 py-3 text-neutro-400">{dateBR(t.createdAt)}</td>
              </tr>
            ))}
            {tickets.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-neutro-500">
                  Nenhum chamado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
