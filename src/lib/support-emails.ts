import { sendEmail, renderEmail } from "./email";
import { env } from "./env";

/**
 * E-mails do ciclo de atendimento.
 *
 * Regra que atravessa este arquivo: **e-mail nunca derruba o chamado**. Se o
 * envio falhar (chave do provedor inválida, provedor fora do ar, domínio ainda
 * não verificado), o registro no banco já está gravado e a falha vira log — o
 * cliente não recebe um erro por causa de uma notificação, e a resposta do
 * suporte não é perdida. Por isso todo envio passa por `tentarEnviar`.
 *
 * Consequência prática: o sistema funciona hoje com a chave do Resend
 * pendente. Quando a chave válida entrar em RESEND_API_KEY, os e-mails passam
 * a sair sem nenhuma alteração de código.
 */

async function tentarEnviar(rotulo: string, to: string, subject: string, html: string, text: string): Promise<void> {
  try {
    await sendEmail({ to, subject, html, text });
  } catch (err) {
    console.error(`[suporte:email] falha ao enviar "${rotulo}" para ${to}:`, (err as Error).message);
  }
}

function linkAdmin(): string {
  return `${env.appUrl}/admin/suporte`;
}
function linkCliente(): string {
  return `${env.appUrl}/suporte`;
}

/** Avisa a equipe que um chamado novo entrou. Sem isto, chamado urgente fica invisível. */
export async function notificarChamadoAberto(params: {
  para: string;
  numero: number;
  assunto: string;
  prioridade: string;
  clienteNome: string;
  clienteEmail: string;
  mensagem: string;
}): Promise<void> {
  const titulo = `Novo chamado #${params.numero} — ${params.prioridade}`;
  const corpo = `
    <p><strong>${escapar(params.clienteNome)}</strong> (${escapar(params.clienteEmail)}) abriu um chamado.</p>
    <p><strong>Assunto:</strong> ${escapar(params.assunto)}<br/>
       <strong>Prioridade:</strong> ${escapar(params.prioridade)}</p>
    <p style="background:#F1F5F9;padding:12px;border-radius:8px;white-space:pre-wrap">${escapar(params.mensagem)}</p>`;
  await tentarEnviar(
    "chamado_aberto",
    params.para,
    titulo,
    renderEmail(titulo, corpo, { label: "Abrir o chamado", url: linkAdmin() }),
    `Novo chamado #${params.numero} (${params.prioridade}) de ${params.clienteNome} <${params.clienteEmail}>\n\nAssunto: ${params.assunto}\n\n${params.mensagem}\n\n${linkAdmin()}`,
  );
}

/** Avisa o cliente que houve resposta no chamado dele. */
export async function notificarRespostaAoCliente(params: {
  para: string;
  nome: string;
  numero: number;
  assunto: string;
  resposta: string;
}): Promise<void> {
  const titulo = `Resposta no seu chamado #${params.numero}`;
  const corpo = `
    <p>Olá, ${escapar(params.nome)}.</p>
    <p>Respondemos o seu chamado <strong>#${params.numero} — ${escapar(params.assunto)}</strong>:</p>
    <p style="background:#F1F5F9;padding:12px;border-radius:8px;white-space:pre-wrap">${escapar(params.resposta)}</p>
    <p>Você pode responder pelo painel, na área de Suporte.</p>`;
  await tentarEnviar(
    "resposta_cliente",
    params.para,
    titulo,
    renderEmail(titulo, corpo, { label: "Ver o chamado", url: linkCliente() }),
    `Resposta no seu chamado #${params.numero} — ${params.assunto}\n\n${params.resposta}\n\n${linkCliente()}`,
  );
}

/** Avisa o cliente que o chamado foi resolvido/encerrado. */
export async function notificarChamadoResolvido(params: {
  para: string;
  nome: string;
  numero: number;
  assunto: string;
  encerrado?: boolean;
}): Promise<void> {
  const acao = params.encerrado ? "encerrado" : "resolvido";
  const titulo = `Chamado #${params.numero} ${acao}`;
  const corpo = `
    <p>Olá, ${escapar(params.nome)}.</p>
    <p>Seu chamado <strong>#${params.numero} — ${escapar(params.assunto)}</strong> foi marcado como <strong>${acao}</strong>.</p>
    <p>Se o problema voltar a ocorrer, responda no próprio chamado — ele é reaberto automaticamente.</p>`;
  await tentarEnviar(
    "chamado_resolvido",
    params.para,
    titulo,
    renderEmail(titulo, corpo, { label: "Ver o chamado", url: linkCliente() }),
    `Seu chamado #${params.numero} — ${params.assunto} foi ${acao}.\n\n${linkCliente()}`,
  );
}

/** Avisa a equipe que o cliente respondeu (chamado voltou para a fila). */
export async function notificarRespostaDoCliente(params: {
  para: string;
  numero: number;
  assunto: string;
  clienteNome: string;
  mensagem: string;
}): Promise<void> {
  const titulo = `Cliente respondeu no chamado #${params.numero}`;
  const corpo = `
    <p><strong>${escapar(params.clienteNome)}</strong> respondeu no chamado <strong>#${params.numero} — ${escapar(params.assunto)}</strong>:</p>
    <p style="background:#F1F5F9;padding:12px;border-radius:8px;white-space:pre-wrap">${escapar(params.mensagem)}</p>`;
  await tentarEnviar(
    "resposta_do_cliente",
    params.para,
    titulo,
    renderEmail(titulo, corpo, { label: "Abrir o chamado", url: linkAdmin() }),
    `${params.clienteNome} respondeu no chamado #${params.numero} — ${params.assunto}\n\n${params.mensagem}\n\n${linkAdmin()}`,
  );
}

/**
 * Escapa HTML. O corpo da mensagem vem digitado pelo cliente e vai para dentro
 * de um e-mail HTML — sem isto, um cliente poderia injetar marcação na caixa de
 * entrada de quem lê o chamado.
 */
function escapar(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
