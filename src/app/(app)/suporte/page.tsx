import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { SupportForm } from "@/components/app/support-form";
import { CanaisAtendimento } from "@/components/ui/canais-atendimento";
import { dateBR } from "@/lib/format";

export const dynamic = "force-dynamic";

const ROTULO_STATUS: Record<string, string> = {
  ABERTO: "Aberto",
  EM_ATENDIMENTO: "Em atendimento",
  AGUARDANDO_CLIENTE: "Aguardando você",
  RESOLVIDO: "Resolvido",
  ENCERRADO: "Encerrado",
};

export default async function SuportePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const tickets = await prisma.supportTicket.findMany({
    where: { requesterId: user.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { messages: true } } },
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <h1 className="mb-4 text-2xl">Suporte</h1>
        <div className="card mb-6 p-5">
          <h2 className="text-sm font-semibold text-marinho-700">Atendimento por WhatsApp</h2>
          <CanaisAtendimento className="mt-3" />
        </div>
        <SupportForm />
      </div>
      <div>
        <h2 className="mb-4 text-lg">Meus chamados</h2>
        <div className="card divide-y divide-neutro-100">
          {tickets.length === 0 ? (
            <p className="p-6 text-sm text-neutro-500">Nenhum chamado aberto.</p>
          ) : (
            tickets.map((t) => (
              // Leva à conversa: antes só havia a contagem de mensagens, e o
              // cliente nunca conseguia ler a resposta do suporte.
              <Link
                key={t.id}
                href={`/suporte/${t.id}`}
                className="flex items-center justify-between gap-3 p-4 hover:bg-neutro-50 dark:hover:bg-neutro-800/50"
              >
                <div>
                  <div className="font-medium text-marca-600 dark:text-marca-300">#{t.number} · {t.subject}</div>
                  <div className="text-xs text-neutro-400">{dateBR(t.createdAt)} · {t._count.messages} mensagem(ns)</div>
                </div>
                <span className="badge bg-marca-50 text-marca-700 dark:bg-marca-500/20 dark:text-marca-200">
                  {ROTULO_STATUS[t.status] ?? t.status}
                </span>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
