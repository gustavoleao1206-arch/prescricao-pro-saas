import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { ativarAssinaturaManual } from "@/lib/ativacao-manual";
import { z } from "zod";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().email("Informe um e-mail válido."),
  nome: z.string().max(160).optional(),
  planoSlug: z.string().min(1, "Escolha o plano."),
  /** Valor recebido em reais (a interface trabalha em reais; convertemos aqui). */
  valorReais: z.number().nonnegative().max(1_000_000).optional(),
  metodo: z.string().max(40).optional(),
  motivo: z.string().min(3, "Descreva o motivo da liberação.").max(300),
  enviarConvite: z.boolean().optional(),
});

/**
 * Libera acesso manualmente — venda por PIX, transferência, boleto, contrato, ou
 * conserto quando o webhook do provedor falhou.
 *
 * Só ADMIN, verificado no servidor. A operação é registrada em auditoria com
 * quem liberou, para quem, valor, método e motivo.
 */
export const POST = route(async (req: NextRequest) => {
  const admin = await requireRole("ADMIN");
  const c = schema.parse(await req.json());

  try {
    const r = await ativarAssinaturaManual(
      {
        email: c.email,
        nome: c.nome,
        planoSlug: c.planoSlug,
        valorCents: c.valorReais === undefined ? undefined : Math.round(c.valorReais * 100),
        metodo: c.metodo,
        motivo: c.motivo,
        enviarConvite: c.enviarConvite,
      },
      { id: admin.id },
    );
    return ok(r, { status: 201 });
  } catch (err) {
    // Mensagens do domínio são seguras de exibir (plano inexistente, nome
    // faltando para conta nova, etc.).
    return fail((err as Error).message, 422);
  }
});
