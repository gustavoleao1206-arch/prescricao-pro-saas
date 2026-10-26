import { prisma } from "./db";
import { logAudit } from "./audit";
import {
  notificarChamadoAberto,
  notificarRespostaAoCliente,
  notificarChamadoResolvido,
  notificarRespostaDoCliente,
} from "./support-emails";
import type { TicketStatus } from "@prisma/client";
import { logLeitura } from "./audit";
import type { Role } from "@prisma/client";

/**
 * Ciclo de vida dos chamados de suporte.
 *
 * Antes deste arquivo o sistema só sabia CRIAR chamado: não havia nenhuma
 * escrita em SupportMessage fora da mensagem inicial do cliente, `status` nunca
 * era reescrito e `resolvedAt`/`agentId` eram campos mortos no schema. Cada
 * chamado era um beco sem saída — o atendimento acontecia por fora, sem
 * registro. Aqui ficam as três operações que faltavam: responder, mudar status e
 * ler a conversa.
 *
 * Regras de negócio que moram aqui (e não na rota, para valerem em qualquer
 * ponto de entrada):
 *
 *  - Responder da equipe move ABERTO → EM_ATENDIMENTO automaticamente. Sem isso
 *    o dono teria que lembrar de mudar o status na mão a cada resposta, e o
 *    contador "Chamados abertos" do painel continuaria sem significado.
 *  - Responder do cliente REABRE chamado resolvido/encerrado. Se o problema
 *    voltou, ele não deveria precisar abrir um chamado novo e perder o
 *    histórico.
 *  - RESOLVIDO/ENCERRADO grava `resolvedAt`; sair desse estado limpa o campo,
 *    para a métrica de tempo de resolução não mentir.
 */

/** Papéis que atendem chamados (veem todos e podem responder como equipe). */
export function ehEquipe(role: string): boolean {
  return role === "ADMIN" || role === "SUPORTE";
}

const ESTADOS_FECHADOS: TicketStatus[] = ["RESOLVIDO", "ENCERRADO"];

/** Para quem mandar aviso de chamado novo/resposta do cliente. */
async function emailDaEquipe(): Promise<string | null> {
  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN", status: "ATIVO" },
    orderBy: { createdAt: "asc" },
    select: { email: true },
  });
  return admin?.email ?? null;
}

/** Carrega o chamado com a conversa completa, respeitando quem pode ver. */
export async function carregarChamado(ticketId: string, usuario: { id: string; role: string }) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: {
      requester: { select: { id: true, name: true, email: true } },
      agent: { select: { id: true, name: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        include: { author: { select: { id: true, name: true, role: true } } },
      },
    },
  });
  if (!ticket) return null;
  // Isolamento: cliente só vê o próprio chamado.
  if (!ehEquipe(usuario.role) && ticket.requesterId !== usuario.id) return null;

  /**
   * ⚠️ Registra a leitura DA EQUIPE — e o registro fica aqui, não nas telas.
   *
   * É o mesmo argumento que este arquivo já usa para as demais regras: aqui elas valem em qualquer ponto de
   * entrada. São dois hoje (a rota da API e a tela do admin), e o próximo nasceria sem registro.
   *
   * O chamado é onde o cliente cola número de processo, nome de parte e às vezes o próprio documento em
   * texto, para explicar o problema. Responder já era registrado; LER não — o que produzia uma trilha
   * enganosa, porque quem lê e vai embora sem responder era invisível, e é justamente essa a leitura que
   * interessa numa apuração.
   *
   * Só a equipe: o cliente lendo o próprio chamado não é o fato que se quer rastrear.
   */
  if (ehEquipe(usuario.role)) {
    await logLeitura({
      actorId: usuario.id,
      actorRole: usuario.role as Role,
      action: "support.ticket_read",
      entityType: "SupportTicket",
      entityId: ticket.id,
    });
  }

  return ticket;
}

export interface ResultadoResposta {
  ticketId: string;
  numero: number;
  statusNovo: TicketStatus;
  reaberto: boolean;
}

/**
 * Grava uma resposta no chamado e ajusta o status conforme quem respondeu.
 * Retorna o estado resultante para a interface refletir sem recarregar tudo.
 */
export async function responderChamado(
  ticketId: string,
  autor: { id: string; role: string; name: string },
  corpo: string,
): Promise<ResultadoResposta | null> {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: { requester: { select: { name: true, email: true } } },
  });
  if (!ticket) return null;

  const daEquipe = ehEquipe(autor.role);
  if (!daEquipe && ticket.requesterId !== autor.id) return null;

  const estavaFechado = ESTADOS_FECHADOS.includes(ticket.status);
  // Equipe respondendo: assume o atendimento. Cliente respondendo: devolve para
  // a fila (e reabre, se estava fechado).
  const statusNovo: TicketStatus = daEquipe ? "AGUARDANDO_CLIENTE" : "EM_ATENDIMENTO";
  const reaberto = !daEquipe && estavaFechado;

  const [mensagem] = await prisma.$transaction([
    prisma.supportMessage.create({
      data: { ticketId: ticket.id, authorId: autor.id, body: corpo },
    }),
    prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: statusNovo,
        // Primeiro atendente que responde fica como responsável.
        agentId: daEquipe ? ticket.agentId ?? autor.id : ticket.agentId,
        // Saiu de resolvido: a data de resolução não vale mais.
        resolvedAt: ESTADOS_FECHADOS.includes(statusNovo) ? ticket.resolvedAt : null,
      },
    }),
  ]);

  await logAudit({
    actorId: autor.id,
    action: daEquipe ? "support.ticket_reply" : "support.ticket_client_reply",
    entityType: "SupportTicket",
    entityId: ticket.id,
    metadata: { numero: ticket.number, statusNovo, reaberto, mensagemId: mensagem.id },
  });

  if (daEquipe) {
    await notificarRespostaAoCliente({
      para: ticket.requester.email,
      nome: ticket.requester.name,
      numero: ticket.number,
      assunto: ticket.subject,
      resposta: corpo,
    });
  } else {
    const equipe = await emailDaEquipe();
    if (equipe) {
      await notificarRespostaDoCliente({
        para: equipe,
        numero: ticket.number,
        assunto: ticket.subject,
        clienteNome: ticket.requester.name,
        mensagem: corpo,
      });
    }
  }

  return { ticketId: ticket.id, numero: ticket.number, statusNovo, reaberto };
}

/** Muda o status do chamado (ação da equipe). */
export async function mudarStatusChamado(
  ticketId: string,
  ator: { id: string; role: string },
  status: TicketStatus,
): Promise<{ numero: number; status: TicketStatus } | null> {
  if (!ehEquipe(ator.role)) return null;
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: { requester: { select: { name: true, email: true } } },
  });
  if (!ticket) return null;

  const fechando = ESTADOS_FECHADOS.includes(status);
  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: {
      status,
      // Grava a resolução na primeira vez; ao reabrir, limpa — assim o tempo de
      // resolução medido corresponde ao fechamento que valeu.
      resolvedAt: fechando ? ticket.resolvedAt ?? new Date() : null,
      agentId: ticket.agentId ?? ator.id,
    },
  });

  await logAudit({
    actorId: ator.id,
    action: "support.ticket_status",
    entityType: "SupportTicket",
    entityId: ticket.id,
    metadata: { numero: ticket.number, de: ticket.status, para: status },
  });

  if (fechando) {
    await notificarChamadoResolvido({
      para: ticket.requester.email,
      nome: ticket.requester.name,
      numero: ticket.number,
      assunto: ticket.subject,
      encerrado: status === "ENCERRADO",
    });
  }
  return { numero: ticket.number, status };
}

/**
 * Avisa a equipe de um chamado recém-aberto. Chamado pela rota de criação;
 * fica aqui para a lógica de "quem recebe" morar num lugar só.
 */
export async function avisarEquipeDeNovoChamado(params: {
  numero: number;
  assunto: string;
  prioridade: string;
  clienteNome: string;
  clienteEmail: string;
  mensagem: string;
}): Promise<void> {
  const para = await emailDaEquipe();
  if (!para) return;
  await notificarChamadoAberto({ para, ...params });
}
