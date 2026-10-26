import { sendEmail, renderEmail } from "./email";
import { env } from "./env";

/**
 * E-mails transacionais do ciclo de vida da assinatura (Prescrição Pro).
 * Layout de marca vem de renderEmail(); o envio respeita EMAIL_DRIVER (console/resend/smtp).
 *
 * Regra: NUNCA enviar a senha do cliente. Contas novas recebem um link seguro
 * para o próprio cliente criar a senha.
 */

interface EmailUser {
  email: string;
  name: string;
}

const APP = env.appName;
const loginUrl = `${env.appUrl}/login`;
const assinaturaUrl = `${env.appUrl}/assinatura`;

function fmtBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtDate(d?: Date | null): string {
  return d ? d.toLocaleDateString("pt-BR") : "-";
}

/** Contas NOVAS (provisionadas pela compra): boas-vindas + link seguro para criar senha. */
export async function sendWelcomeCreatePassword(user: EmailUser, createPasswordUrl: string, priceCents: number): Promise<void> {
  await sendEmail({
    to: user.email,
    subject: `Bem-vindo(a) ao ${APP}: crie sua senha e acesse`,
    html: renderEmail(
      "Seu acesso foi ativado. Crie sua senha",
      `<p>Olá, ${user.name}.</p>
       <p>Seu acesso ao <strong>${APP}</strong> foi ativado com sucesso.</p>
       <p><strong>Plano:</strong> ${APP}<br/>
          <strong>Valor:</strong> ${fmtBRL(priceCents)} por mês<br/>
          <strong>Periodicidade:</strong> mensal<br/>
          <strong>Status:</strong> ativo</p>
       <p>Para entrar, crie sua senha pelo botão abaixo (o link é pessoal e temporário).</p>`,
      { label: "Criar minha senha", url: createPasswordUrl },
    ),
    text: `Olá, ${user.name}. Seu acesso ao ${APP} foi ativado. Plano: ${APP}. Valor: ${fmtBRL(priceCents)}/mês. Crie sua senha: ${createPasswordUrl}`,
  });
}

/** Contas já existentes (cadastro-antes): assinatura ativada, com CTA de login. */
export async function sendActivated(user: EmailUser, priceCents: number): Promise<void> {
  await sendEmail({
    to: user.email,
    subject: `Seu acesso ao ${APP} foi ativado`,
    html: renderEmail(
      "Assinatura ativada",
      `<p>Olá, ${user.name}.</p>
       <p>Seu acesso ao <strong>${APP}</strong> foi ativado com sucesso.</p>
       <p><strong>Plano:</strong> ${APP}<br/>
          <strong>Valor:</strong> ${fmtBRL(priceCents)} por mês<br/>
          <strong>Periodicidade:</strong> mensal<br/>
          <strong>Status:</strong> ativo</p>
       <p>Acesse sua conta utilizando o e-mail cadastrado e a senha criada por você.</p>
       <p style="color:#64748B;font-size:12px">Atenciosamente,<br/>Equipe ${APP}, Leão Amorim</p>`,
      { label: "Acessar o aplicativo", url: loginUrl },
    ),
    text: `Olá, ${user.name}. Seu acesso ao ${APP} foi ativado. Plano: ${APP}. Valor: ${fmtBRL(priceCents)}/mês. Acesse: ${loginUrl}`,
  });
}

/** Renovação mensal confirmada. */
export async function sendRenewalConfirmed(user: EmailUser, priceCents: number, nextChargeAt?: Date | null): Promise<void> {
  await sendEmail({
    to: user.email,
    subject: `Renovação confirmada no ${APP}`,
    html: renderEmail(
      "Renovação mensal confirmada",
      `<p>Olá, ${user.name}.</p>
       <p>Recebemos o pagamento da renovação da sua assinatura do <strong>${APP}</strong>.</p>
       <p><strong>Valor:</strong> ${fmtBRL(priceCents)}<br/>
          <strong>Próxima cobrança:</strong> ${fmtDate(nextChargeAt)}</p>
       <p>Seu acesso segue ativo e ilimitado.</p>`,
      { label: "Acessar o aplicativo", url: loginUrl },
    ),
    text: `Olá, ${user.name}. Renovação confirmada (${fmtBRL(priceCents)}). Próxima cobrança: ${fmtDate(nextChargeAt)}.`,
  });
}

/** Pagamento recusado. */
export async function sendPaymentRefused(user: EmailUser): Promise<void> {
  await sendEmail({
    to: user.email,
    subject: `Não conseguimos processar seu pagamento do ${APP}`,
    html: renderEmail(
      "Pagamento não aprovado",
      `<p>Olá, ${user.name}.</p>
       <p>Não conseguimos processar o pagamento da sua assinatura do <strong>${APP}</strong>.</p>
       <p>Para manter seu acesso, atualize a forma de pagamento e tente novamente.</p>`,
      { label: "Regularizar pagamento", url: assinaturaUrl },
    ),
    text: `Olá, ${user.name}. Seu pagamento não foi aprovado. Regularize em: ${assinaturaUrl}`,
  });
}

/** Pagamento em atraso (inadimplência). */
export async function sendPaymentLate(user: EmailUser): Promise<void> {
  await sendEmail({
    to: user.email,
    subject: `Pagamento em atraso: regularize seu acesso ao ${APP}`,
    html: renderEmail(
      "Pagamento em atraso",
      `<p>Olá, ${user.name}.</p>
       <p>Identificamos um atraso no pagamento da sua assinatura do <strong>${APP}</strong>.</p>
       <p>Regularize para evitar a suspensão do acesso ao agente.</p>`,
      { label: "Regularizar agora", url: assinaturaUrl },
    ),
    text: `Olá, ${user.name}. Pagamento em atraso. Regularize em: ${assinaturaUrl}`,
  });
}

/** Assinatura suspensa por falta de pagamento. */
export async function sendSuspended(user: EmailUser): Promise<void> {
  await sendEmail({
    to: user.email,
    subject: `Assinatura suspensa no ${APP}`,
    html: renderEmail(
      "Assinatura suspensa",
      `<p>Olá, ${user.name}.</p>
       <p>Sua assinatura do <strong>${APP}</strong> foi suspensa por falta de pagamento.</p>
       <p>Assim que o pagamento for regularizado, seu acesso é reativado automaticamente.</p>`,
      { label: "Reativar acesso", url: assinaturaUrl },
    ),
    text: `Olá, ${user.name}. Assinatura suspensa. Reative em: ${assinaturaUrl}`,
  });
}

/** Assinatura reativada após regularização. */
export async function sendReactivated(user: EmailUser): Promise<void> {
  await sendEmail({
    to: user.email,
    subject: `Assinatura reativada no ${APP}`,
    html: renderEmail(
      "Assinatura reativada",
      `<p>Olá, ${user.name}.</p>
       <p>Boa notícia: sua assinatura do <strong>${APP}</strong> foi reativada e o acesso ao agente está liberado novamente.</p>`,
      { label: "Acessar o aplicativo", url: loginUrl },
    ),
    text: `Olá, ${user.name}. Sua assinatura foi reativada. Acesse: ${loginUrl}`,
  });
}

/** Cancelamento concluído (acesso mantido até o fim do período já pago). */
export async function sendCanceled(user: EmailUser, periodEnd?: Date | null): Promise<void> {
  const ate = periodEnd ? ` até ${fmtDate(periodEnd)}` : "";
  await sendEmail({
    to: user.email,
    subject: `Assinatura cancelada no ${APP}`,
    html: renderEmail(
      "Cancelamento concluído",
      `<p>Olá, ${user.name}.</p>
       <p>Sua assinatura do <strong>${APP}</strong> foi cancelada e não haverá novas cobranças.</p>
       <p>Seu acesso permanece disponível${ate} (fim do período já pago). Você pode reativar quando quiser.</p>`,
      { label: "Reativar assinatura", url: assinaturaUrl },
    ),
    text: `Olá, ${user.name}. Assinatura cancelada, sem novas cobranças. Acesso${ate}. Reative em: ${assinaturaUrl}`,
  });
}

/**
 * Cobrança que entrou DEPOIS do cancelamento — nós avisamos primeiro.
 *
 * ── Por que este e-mail existe ────────────────────────────────────────────────
 * Quem cancelou e vê a cobrança no extrato tem um caminho natural: contestar no
 * cartão. E a contestação é o pior desfecho possível para as duas partes — dispara o
 * fluxo de estorno, que põe a conta em ESTORNADA, bloqueia o saldo e derruba o acesso
 * de um cliente que não fez nada de errado, além de pesar no índice de contestação da
 * conta do Asaas.
 *
 * Dizer antes, com o valor e o compromisso de devolução, resolve o mesmo problema
 * sem nada disso. O texto não pede desculpa genérica: informa que a cobrança não
 * gerou acesso, o que será feito, e por onde acompanhar.
 */
export async function sendUndueCharge(user: EmailUser, amountCents: number): Promise<void> {
  await sendEmail({
    to: user.email,
    subject: `Cobrança indevida de ${fmtBRL(amountCents)} no ${APP}: vamos devolver`,
    html: renderEmail(
      "Identificamos uma cobrança após o seu cancelamento",
      `<p>Olá, ${user.name}.</p>
       <p>Registramos a entrada de <strong>${fmtBRL(amountCents)}</strong> referente ao ${APP}
          <strong>depois</strong> de a sua assinatura ter sido cancelada.</p>
       <p>Duas coisas já estão resolvidas: a cobrança <strong>não</strong> reativou a assinatura e
          <strong>não</strong> gerou acesso nem créditos. E a quantia <strong>será devolvida</strong> —
          nossa equipe foi notificada automaticamente.</p>
       <p>Não é necessário contestar a cobrança no seu banco ou cartão. Se preferir acompanhar,
          fale com o suporte informando este valor.</p>`,
      { label: "Falar com o suporte", url: `${env.appUrl}/suporte` },
    ),
    text:
      `Olá, ${user.name}. Identificamos a entrada de ${fmtBRL(amountCents)} depois do cancelamento da sua ` +
      `assinatura do ${APP}. A cobrança não reativou a assinatura nem gerou acesso, e a quantia será ` +
      `devolvida. Não é necessário contestar no banco. Suporte: ${env.appUrl}/suporte`,
  });
}

/**
 * Pagamento recebido de quem está com o acesso SUSPENSO por decisão administrativa.
 *
 * ── Por que este e-mail existe ────────────────────────────────────────────────
 * Suspensão é sanção sobre o ACESSO, não encerramento do contrato — e ela não interrompe a
 * cobrança. Então a situação existe: o cliente é debitado e continua bloqueado.
 *
 * Antes, o pagamento REATIVAVA a conta sozinho, e o silêncio era coerente com isso. Agora
 * que pagar não desfaz a suspensão (decisão do dono), calar seria o pior desfecho: o
 * cliente veria a cobrança no extrato, tentaria entrar, seria recusado, e não teria ideia
 * do motivo nem de com quem falar. Isso vira contestação de cobrança em poucos dias.
 *
 * O texto não julga e não explica o motivo da suspensão — o motivo é caso a caso e quem o
 * comunica é o atendimento. O que ele faz é o essencial: confirmar que o dinheiro entrou,
 * dizer que o período está preservado, e dar o caminho.
 */
export async function sendPaymentWhileSuspended(user: EmailUser, periodEnd?: Date | null): Promise<void> {
  const ate = periodEnd ? ` (período válido até ${fmtDate(periodEnd)})` : "";
  await sendEmail({
    to: user.email,
    subject: `Pagamento recebido — seu acesso ao ${APP} segue suspenso`,
    html: renderEmail(
      "Recebemos seu pagamento, e o acesso continua suspenso",
      `<p>Olá, ${user.name}.</p>
       <p>Confirmamos o recebimento do pagamento da sua assinatura do <strong>${APP}</strong>${ate}.</p>
       <p>O seu acesso, porém, <strong>continua suspenso</strong> por uma pendência em análise pela nossa equipe —
          e o pagamento, por si, não a resolve. <strong>O período pago está preservado</strong>: nada do que você
          pagou é perdido enquanto isso.</p>
       <p>Fale com o suporte para tratar da pendência e liberar o acesso. Se preferir interromper a cobrança
          enquanto isso, diga no mesmo contato — resolvemos na hora.</p>`,
      { label: "Falar com o suporte", url: `${env.appUrl}/suporte` },
    ),
    text:
      `Olá, ${user.name}. Recebemos o pagamento da sua assinatura do ${APP}${ate}, mas o acesso continua ` +
      `suspenso por uma pendência em análise — o pagamento não a resolve. O período pago está preservado. ` +
      `Fale com o suporte: ${env.appUrl}/suporte`,
  });
}

/** Estorno ou chargeback: assinatura encerrada. */
export async function sendRefunded(user: EmailUser): Promise<void> {
  await sendEmail({
    to: user.email,
    subject: `Estorno processado no ${APP}`,
    html: renderEmail(
      "Estorno processado",
      `<p>Olá, ${user.name}.</p>
       <p>Um estorno foi processado e sua assinatura do <strong>${APP}</strong> foi encerrada.</p>
       <p>Se isso não foi solicitado por você ou deseja retomar o acesso, fale com o suporte.</p>`,
      { label: "Falar com o suporte", url: `${env.appUrl}/suporte` },
    ),
    text: `Olá, ${user.name}. Estorno processado e assinatura encerrada. Suporte: ${env.appUrl}/suporte`,
  });
}
