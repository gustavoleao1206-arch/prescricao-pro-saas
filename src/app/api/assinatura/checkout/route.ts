import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { requireAppContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { emailEstaConfirmado, RECUSA_EMAIL_NAO_CONFIRMADO } from "@/lib/verificacao-email";
import {
  asaasConfigured,
  criarCheckout,
  metodoDeTexto,
  METODOS_DE_PLANO,
  type MetodoDePagamento,
} from "@/lib/asaas";

export const runtime = "nodejs";

/**
 * Devolve o link de checkout para assinar um plano ou comprar crédito avulso.
 *
 * O Asaas é o ÚNICO destino: cada compra gera uma sessão de checkout criada na
 * hora e amarrada a esta conta pelo `externalReference`, que é o que permite
 * creditar a pessoa certa quando o webhook chega.
 *
 * ⚠️ O recuo para `Plan.checkoutUrl` / `CreditPack.checkoutUrl` foi REMOVIDO. Ele
 * existia para quando o Asaas ainda não estava configurado, mas os links gravados
 * nesses campos eram da plataforma anterior, hoje descontinuada. Se a chave do
 * Asaas faltasse por qualquer motivo, o recuo mandaria o cliente pagar numa conta
 * que não é mais usada — dinheiro entrando onde ninguém olha e acesso nunca
 * liberado, porque não há webhook do outro lado. Falhar dizendo "pagamento não
 * configurado" é o comportamento correto: o cliente não paga errado e o problema
 * aparece.
 *
 * A liberação do acesso acontece no webhook, após a confirmação do pagamento.
 */
export const GET = route(async (req: NextRequest) => {
  const ctx = await requireAppContext();
  const params = req.nextUrl.searchParams;
  const planoSlug = params.get("plano");
  const pacoteSlug = params.get("pacote");
  /**
   * Forma de pagamento do plano. Muda o que o cliente contrata, não só a tela:
   * cartão cria assinatura recorrente no Asaas; PIX é cobrança única, sem
   * renovação. Padrão cartão, que é a contratação recorrente.
   *
   * Boleto é recusado aqui de propósito. Antes, qualquer valor diferente de "pix"
   * virava "cartao" — então um pedido de boleto abriria silenciosamente um checkout
   * de CARTÃO, e o cliente contrataria uma forma de pagamento que não escolheu. O
   * boleto tem rota própria (`/api/assinatura/boleto`), porque o Checkout do Asaas
   * não o emite.
   */
  const metodo = metodoDeTexto(params.get("metodo"));
  if (metodo === "boleto") {
    return fail("Boleto não é emitido pelo checkout. Use /api/assinatura/boleto.", 400);
  }

  if (pacoteSlug) {
    const pacote = await prisma.creditPack.findUnique({ where: { slug: pacoteSlug } });
    if (!pacote || !pacote.active) return fail("Crédito avulso não encontrado.", 404);

    /**
     * Crédito avulso exige ACESSO, e não só uma assinatura qualquer no banco.
     *
     * Nada checava isso em nenhuma camada — tela, rota ou webhook. O cliente de PIX com
     * o ciclo vencido via o aviso de saldo zerado, comprava o crédito, o webhook
     * creditava com validade de 90 dias correndo… e a primeira análise era recusada com
     * "assinatura vencida", porque o gate decide por status e prazo ANTES de olhar
     * saldo. Ele pagava por um crédito que não conseguia usar, e o prazo de validade
     * queimava enquanto isso.
     *
     * Quem está sem acesso precisa contratar plano, não comprar crédito — e é isso que
     * a mensagem diz, com o motivo real do bloqueio.
     */
    if (!ctx.access.hasAccess) {
      return fail(
        `${ctx.access.message} O crédito avulso complementa uma assinatura ativa e não daria acesso por si: ` +
          "contrate um plano primeiro.",
        409,
      );
    }

    if (asaasConfigured()) {
      return viaAsaas(ctx.user, `pacote:${pacote.slug}`, () =>
        criarCheckout({ tipo: "pacote", slug: pacote.slug, nome: pacote.name, valorCents: pacote.priceCents, userId: ctx.user.id }),
        ctx.user.role === "ADMIN",
      );
    }
    return fail(
      `O pagamento não está configurado no momento, então "${pacote.name}" não pode ser comprado. ` +
        `Configure o Asaas (ASAAS_API_KEY) para reativar a venda.`,
      503,
    );
  }

  if (planoSlug) {
    const plano = await prisma.plan.findUnique({ where: { slug: planoSlug } });
    if (!plano || !plano.active) return fail("Plano não encontrado.", 404);
    if (plano.contactOnly) return fail("Este plano é contratado pelo atendimento comercial.", 400);

    /**
     * ⚠️ E-mail confirmado é condição para CONTRATAR — decisão do dono.
     *
     * Fica aqui, e não no topo da rota, de propósito: o ramo do crédito avulso acima exige
     * assinatura com ACESSO, ou seja, alguém que já entrou. O gate existe para evitar quem paga
     * e não entra, e aplicá-lo lá seria atrito num cliente que já é cliente.
     *
     * Depois do pagamento, todo contato passa pelo endereço do cadastro: aviso de acesso
     * liberado, recuperação de senha, segunda via do boleto, aviso de cobrança e de devolução.
     * Endereço inalcançável transforma a venda em "paguei e nunca entrei" — e sem recuperação de
     * senha a pessoa não se resolve sozinha. Ver `emailEstaConfirmado`.
     */
    if (!(await emailEstaConfirmado(ctx.user.id))) {
      return fail(RECUSA_EMAIL_NAO_CONFIRMADO, 403, { reason: "email_nao_confirmado" });
    }

    if (asaasConfigured()) {
      return viaAsaas(ctx.user, `plano:${plano.slug}`, () =>
        criarCheckout({
          tipo: "plano",
          slug: plano.slug,
          nome: plano.name,
          valorCents: plano.priceCents,
          userId: ctx.user.id,
          cycle: plano.period === "ANUAL" ? "YEARLY" : "MONTHLY",
          metodo,
        }),
        ctx.user.role === "ADMIN",
        metodo,
      );
    }
    return fail(
      `O pagamento não está configurado no momento, então o plano "${plano.name}" não pode ser contratado. ` +
        `Configure o Asaas (ASAAS_API_KEY) para reativar a venda.`,
      503,
    );
  }

  return fail("Informe o plano ou o pacote desejado para gerar o checkout.", 400);
});

/**
 * Cria o checkout no Asaas, registra a auditoria e devolve a URL.
 *
 * Em caso de falha, a mensagem depende de quem está olhando:
 *  - CLIENTE vê texto genérico. O motivo cru do provedor não é problema dele e
 *    pode conter detalhe operacional que não deve aparecer para o comprador.
 *  - ADMIN vê o motivo REAL devolvido pelo Asaas. Isso existe porque a primeira
 *    falha real em produção ("A criação do checkout está desabilitada.
 *    Regularize a situação cadastral.") só era visível no log do servidor —
 *    quem opera o sistema perdia tempo sem saber que a causa estava na conta do
 *    provedor, não no código.
 */
async function viaAsaas(
  user: { id: string; email: string },
  referencia: string,
  criar: () => Promise<{ url: string }>,
  ehAdmin = false,
  metodo?: MetodoDePagamento,
) {
  try {
    const { url } = await criar();
    await logAudit({ actorId: user.id, action: "subscription.checkout_opened", entityType: "User", entityId: user.id, metadata: { referencia, provider: "asaas" } });
    return ok({ url });
  } catch (err) {
    const motivo = (err as Error).message;
    console.error(`[asaas] falha ao criar checkout (${metodo ?? "sem método"}): ${motivo}`);
    if (ehAdmin) {
      return fail(`Asaas recusou a criação do checkout: ${motivo}`, 502);
    }
    /**
     * O cliente é mandado para OUTRA forma de pagamento, não para "tente de novo".
     *
     * Quando a recusa é da forma escolhida — o provedor sem chave PIX cadastrada, por
     * exemplo — tentar de novo nunca funciona, e a mensagem anterior prendia a pessoa
     * num laço: erro, retentativa, mesmo erro. Perde-se a venda por uma falha que
     * outro botão da mesma tela resolveria. Como não há como distinguir com segurança
     * a recusa da forma de pagamento de uma falha momentânea, a saída é oferecer as
     * duas leituras e o caminho alternativo.
     */
    const alternativas = METODOS_DE_PLANO.filter((m) => m.valor !== metodo).map((m) => m.rotulo);
    const sugestao = alternativas.length > 0 ? ` Enquanto isso, você pode pagar com ${listar(alternativas)}.` : "";
    return fail(
      `Não foi possível abrir o pagamento${metodo ? ` em ${rotuloDoMetodo(metodo)}` : ""} agora.${sugestao}` +
        " Se preferir, avise o suporte que resolvemos para você.",
      502,
    );
  }
}

/** Rótulo comercial do método, para a mensagem de erro falar a língua do cliente. */
function rotuloDoMetodo(metodo: MetodoDePagamento): string {
  return METODOS_DE_PLANO.find((m) => m.valor === metodo)?.rotulo.toLowerCase() ?? metodo;
}

const listar = (itens: string[]) =>
  itens.length <= 1 ? (itens[0] ?? "") : `${itens.slice(0, -1).join(", ")} ou ${itens[itens.length - 1]}`;
