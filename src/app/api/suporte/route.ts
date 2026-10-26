import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { supportTicketSchema } from "@/lib/validation";
import { logAudit } from "@/lib/audit";
import { avisarEquipeDeNovoChamado } from "@/lib/support";

export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  const data = supportTicketSchema.parse(await req.json());

  const ticket = await prisma.supportTicket.create({
    data: {
      requesterId: user.id,
      subject: data.subject,
      category: data.category,
      priority: data.priority,
      status: "ABERTO",
      messages: { create: { authorId: user.id, body: data.message } },
    },
  });

  await logAudit({ actorId: user.id, action: "support.ticket_open", entityType: "SupportTicket", entityId: ticket.id });

  // Avisa a equipe. Antes disto ninguém era notificado: um chamado urgente
  // aberto de madrugada ficava invisível até alguém abrir /admin/suporte na mão.
  // O envio nunca derruba a abertura do chamado (ver src/lib/support-emails.ts).
  await avisarEquipeDeNovoChamado({
    numero: ticket.number,
    assunto: ticket.subject,
    prioridade: data.priority,
    clienteNome: user.name,
    clienteEmail: user.email,
    mensagem: data.message,
  });

  return ok({ id: ticket.id, number: ticket.number }, { status: 201 });
});

export const GET = route(async () => {
  const user = await requireUser();
  // Suporte/Admin veem todos; cliente vê apenas os seus.
  const where = user.role === "ADMIN" || user.role === "SUPORTE" ? {} : { requesterId: user.id };
  const tickets = await prisma.supportTicket.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { requester: { select: { name: true, email: true } }, _count: { select: { messages: true } } },
  });
  return ok({ tickets });
});
