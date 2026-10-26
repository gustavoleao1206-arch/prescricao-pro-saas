import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { contactSchema } from "@/lib/validation";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { sendEmail, renderEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import { env } from "@/lib/env";

export const POST = route(async (req: NextRequest) => {
  const ip = clientIp(req);
  const rl = rateLimit(`contato:${ip}`, 5, 60);
  if (!rl.allowed) return fail("Muitas mensagens em pouco tempo. Aguarde um instante.", 429);

  const body = await req.json();
  const data = contactSchema.parse(body);

  const protocolo = `CT-${Date.now().toString(36).toUpperCase()}`;

  // Encaminha para o e-mail de contato configurado (driver console em dev).
  await sendEmail({
    to: env.email.from,
    subject: `[Contato ${protocolo}] ${data.name}`,
    html: renderEmail(
      `Nova mensagem de contato (${protocolo})`,
      `<p><strong>Nome:</strong> ${escapeHtml(data.name)}</p>
       <p><strong>E-mail:</strong> ${escapeHtml(data.email)}</p>
       <p><strong>Telefone:</strong> ${escapeHtml(data.phone ?? "—")}</p>
       <p><strong>Mensagem:</strong><br/>${escapeHtml(data.message)}</p>`,
    ),
  });

  await logAudit({ action: "contato.enviado", metadata: { protocolo }, ip });
  return ok({ protocolo });
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
