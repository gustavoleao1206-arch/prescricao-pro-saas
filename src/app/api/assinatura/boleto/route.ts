import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireAppContext } from "@/lib/tenant";
import { logAudit } from "@/lib/audit";
import { encryptField } from "@/lib/crypto";
import { validarCpfCnpj } from "@/lib/documento";
import { asaasConfigured, criarAssinaturaBoleto } from "@/lib/asaas";
import { emailEstaConfirmado, RECUSA_EMAIL_NAO_CONFIRMADO } from "@/lib/verificacao-email";

export const runtime = "nodejs";

const corpo = z.object({
  planoSlug: z.string().min(1, "Informe o plano."),
  cpfCnpj: z.string().min(11, "Informe o CPF ou CNPJ."),
});

/**
 * Contratação por BOLETO.
 *
 * Fluxo diferente do cartão e do PIX porque o Checkout hospedado do Asaas não
 * aceita boleto — `billingTypes` admite só CREDIT_CARD e PIX. Boleto existe apenas
 * na API de Assinaturas, que exige um cliente criado antes, com CPF/CNPJ.
 *
 * Ou seja: aqui SOMOS NÓS que pedimos o documento, papel que a página do Asaas
 * cumpria nos outros métodos. Por isso a validação dos dígitos verificadores é
 * feita antes de falar com o provedor: documento errado devolve "CPF inválido" no
 * campo, em vez de um erro cru de gateway no meio da compra.
 *
 * O documento é gravado CRIPTOGRAFADO (AES-256-GCM) em `User.documentEnc`, porque é
 * dado pessoal sob a LGPD. O valor em claro só transita para o Asaas.
 */
export const POST = route(async (req: NextRequest) => {
  const ctx = await requireAppContext();
  /**
   * ⚠️ NÃO exija organização aqui.
   *
   * Havia um `if (!ctx.organization) return fail("Organização não encontrada.", 400)` nesta
   * linha, e ele barrava a emissão sem servir para nada: esta rota não usa a organização
   * em ponto nenhum — trabalha com `ctx.user` (nome, e-mail, documento) e com
   * `ctx.currentSubscription`. Era um portão sem porta atrás.
   *
   * E barrava de verdade. A organização nasce em dois lugares: no cadastro pelo site e,
   * na primeira aprovação de pagamento, dentro do webhook (`obterOuCriarOrg`). Conta
   * criada por outro caminho — o ADMIN da semente, um REVISOR, um SUPORTE — não tem
   * organização, e recebia "Organização não encontrada" ao tentar emitir boleto. Foi
   * exatamente o que aconteceu no primeiro teste pela tela.
   *
   * Cartão e PIX nunca precisaram: a rota de checkout também só usa `ctx.user`, e é o
   * webhook que cria a organização quando o dinheiro entra. A assimetria era o defeito —
   * o boleto recusava onde os outros dois seguiam.
   */
  if (!asaasConfigured()) {
    return fail("O pagamento não está configurado no momento. Fale com o suporte.", 503);
  }

  const dados = corpo.safeParse(await req.json().catch(() => null));
  if (!dados.success) return fail(dados.error.issues[0]?.message ?? "Dados inválidos.", 422);

  const documento = validarCpfCnpj(dados.data.cpfCnpj);
  if (!documento) {
    return fail("O CPF ou CNPJ informado não é válido. Confira os números e tente novamente.", 422);
  }

  const plano = await prisma.plan.findUnique({ where: { slug: dados.data.planoSlug } });
  if (!plano || !plano.active) return fail("Plano não encontrado.", 404);
  if (plano.contactOnly) return fail("Este plano é contratado pelo atendimento comercial.", 400);


  /**
   * O bloqueio é por RECORRÊNCIA, não por assinatura ativa.
   *
   * A regra era "tem assinatura ATIVA, recusa", e isso é largo demais: barrava
   * justamente quem mais precisa contratar por boleto — quem pagou por PIX, cujo
   * acesso vale um ciclo e ENCERRA, e que precisa contratar de novo para continuar.
   * A pessoa via "você já tem assinatura ativa" e era mandada para "Mudar de plano",
   * que muda o plano e não a forma de pagamento. Sem saída, dentro do produto.
   *
   * O que realmente não pode coexistir são duas RECORRÊNCIAS: cartão e boleto cobram
   * sozinhos, e duas ao mesmo tempo é cobrança dupla todo mês — aconteceu de verdade
   * no primeiro teste de pagamento. `nextRenewalAt` preenchido é exatamente o sinal
   * de "esta assinatura se cobra sozinha", então é ele que barra.
   *
   * Sem renovação (PIX, liberação manual), emitir boleto é seguro: `ativarAssinatura`
   * ATUALIZA a assinatura da organização em vez de criar outra.
   */
  const atual = ctx.currentSubscription;
  if (atual && atual.status === "ATIVA" && atual.nextRenewalAt !== null) {
    return fail(
      "Sua assinatura atual já renova automaticamente, e manter duas cobranças recorrentes geraria cobrança dupla. " +
        "Para passar a pagar por boleto, cancele a assinatura atual — o acesso continua até o fim do período já pago — " +
        "e contrate por boleto em seguida.",
      409,
    );
  }

  /**
   * ⚠️ E-mail confirmado é condição para CONTRATAR — a mesma regra do checkout.
   *
   * Aqui pesa ainda mais que no cartão e no PIX: o boleto é enviado POR E-MAIL pelo Asaas, e a
   * segunda via também. Endereço inalcançável significa cobrança emitida que o cliente nunca vê
   * — ele espera um boleto que não chega, a cobrança vence, e a recorrência ainda tenta o ciclo
   * seguinte. Ver `emailEstaConfirmado`.
   *
   * ── Por que DEPOIS da guarda de cobrança dupla ──────────────────────────────
   * A ordem foi corrigida ao ver o efeito: com o gate antes, quem já tinha recorrência ativa
   * passou a receber "confirme seu e-mail" em vez de "você já tem uma assinatura que renova".
   * As duas recusas são verdadeiras, mas só a segunda descreve a situação da pessoa e diz o que
   * fazer. Recusa deve dar o motivo mais específico, não o primeiro que o código encontra.
   */
  if (!(await emailEstaConfirmado(ctx.user.id))) {
    return fail(RECUSA_EMAIL_NAO_CONFIRMADO, 403, { reason: "email_nao_confirmado" });
  }

  try {
    const r = await criarAssinaturaBoleto({
      userId: ctx.user.id,
      nome: ctx.user.name,
      email: ctx.user.email,
      cpfCnpj: documento.digitos,
      planoSlug: plano.slug,
      planoNome: plano.name,
      valorCents: plano.priceCents,
      cycle: plano.period === "ANUAL" ? "YEARLY" : "MONTHLY",
    });

    // Guarda o documento para não pedir de novo na próxima contratação.
    await prisma.user.update({
      where: { id: ctx.user.id },
      data: { documentEnc: encryptField(documento.digitos), documentType: documento.tipo },
    });

    await logAudit({
      actorId: ctx.user.id,
      action: "subscription.boleto_emitido",
      entityType: "User",
      entityId: ctx.user.id,
      // Sem o documento nos metadados: auditoria não é lugar de dado pessoal.
      metadata: { plano: plano.slug, assinaturaAsaas: r.assinaturaId, tipoDocumento: documento.tipo },
    });

    return ok({
      assinaturaId: r.assinaturaId,
      boletoUrl: r.boletoUrl,
      faturaUrl: r.faturaUrl,
      vencimento: r.vencimento,
      message:
        r.boletoUrl || r.faturaUrl
          ? "Boleto emitido. O acesso é liberado quando o pagamento for confirmado pelo banco, o que costuma levar de 1 a 3 dias úteis."
          : "Assinatura criada e o boleto foi enviado para o seu e-mail. O acesso é liberado quando o pagamento for confirmado pelo banco.",
    });
  } catch (err) {
    const motivo = (err as Error).message;
    console.error("[boleto] falha ao emitir:", motivo);
    // O motivo cru do provedor é operacional; o comprador vê texto útil, o admin vê o real.
    if (ctx.user.role === "ADMIN") return fail(`Asaas recusou a emissão do boleto: ${motivo}`, 502);
    return fail("Não foi possível emitir o boleto agora. Tente novamente em instantes.", 502);
  }
});
