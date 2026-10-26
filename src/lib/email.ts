import { env } from "./env";

/**
 * Envio de e-mail transacional com drivers plugáveis.
 *  - "console": imprime no log (desenvolvimento).
 *  - "resend": usa a API do Resend.
 *  - "smtp": requer nodemailer (não instalado por padrão — ver PENDENCIAS).
 *
 * Os corpos são gerados a partir de modelos editáveis (ContentBlock "email.*").
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  switch (env.email.driver) {
    case "resend":
      return sendViaResend(msg);
    case "smtp":
      return sendViaSmtp(msg);
    case "console":
    default:
      // eslint-disable-next-line no-console
      console.info(`\n[email:console] Para: ${msg.to}\nAssunto: ${msg.subject}\n${msg.text ?? msg.html}\n`);
  }
}

async function sendViaResend(msg: EmailMessage): Promise<void> {
  if (!env.email.resendKey) {
    throw new Error("EMAIL_DRIVER=resend mas RESEND_API_KEY não está configurada.");
  }
  const { Resend } = await import("resend");
  const resend = new Resend(env.email.resendKey);

  /**
   * O SDK do Resend NÃO lança exceção em erro de API: ele devolve
   * `{ data, error }` — veja `error: null | ErrorResponse` nos tipos do pacote.
   * A versão anterior descartava esse retorno, então chave inválida, domínio não
   * verificado ou remetente recusado eram tratados como envio bem-sucedido.
   *
   * O efeito era grave e silencioso: o cadastro respondia 201 "verifique seu
   * e-mail", nenhum e-mail saía, e nada aparecia no log — o problema ficou
   * invisível por dias, porque a falha era indistinguível do sucesso.
   */
  const { data, error } = await resend.emails.send({
    from: env.email.from,
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  });

  if (error) {
    // Mensagem com o que o provedor de fato reclamou, para o diagnóstico não
    // depender de adivinhação.
    throw new Error(
      `Resend recusou o envio para ${msg.to}: ${error.name ?? "erro"} — ${error.message ?? "sem detalhe"}`,
    );
  }
  if (!data?.id) {
    throw new Error(`Resend não confirmou o envio para ${msg.to} (resposta sem identificador).`);
  }
}

async function sendViaSmtp(_msg: EmailMessage): Promise<void> {
  throw new Error(
    "Driver SMTP requer nodemailer (não instalado). Use EMAIL_DRIVER=resend ou instale nodemailer.",
  );
}

/** Layout base dos e-mails, com identidade visual do produto. */
export function renderEmail(title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#F1F5F9;font-family:Arial,Helvetica,sans-serif;color:#0F172A">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#060A14;color:#EAF0FB;padding:20px 24px;border-radius:12px 12px 0 0">
      <strong style="font-size:18px">Prescrição Pro</strong>
      <div style="color:#4F7CFF;font-size:12px;letter-spacing:.08em;text-transform:uppercase">Leão Amorim Tecnologia</div>
    </div>
    <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px">
      <h1 style="font-size:18px;margin:0 0 12px">${title}</h1>
      <div style="font-size:14px;line-height:1.6">${bodyHtml}</div>
      ${
        cta
          ? `<p style="margin:24px 0"><a href="${cta.url}" style="background:#4F7CFF;color:#FFFFFF;font-weight:bold;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">${cta.label}</a></p>`
          : ""
      }
      <p style="color:#64748B;font-size:12px;margin-top:24px">
        Este é um e-mail automático. Em caso de dúvida, utilize os canais de suporte da plataforma.
      </p>
    </div>
  </div></body></html>`;
}
