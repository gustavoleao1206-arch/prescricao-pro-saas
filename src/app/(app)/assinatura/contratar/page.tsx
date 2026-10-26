import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { precoBR } from "@/lib/planos";
import { metodoDeTexto, METODOS_DE_PLANO } from "@/lib/asaas";
import { IrParaPagamento } from "@/components/app/ir-para-pagamento";
import { ContratarBoleto } from "@/components/app/contratar-boleto";
import { EscolherMetodo } from "@/components/app/escolher-metodo";

export const dynamic = "force-dynamic";

/**
 * Ponto ÚNICO de entrada para contratar um plano: `/assinatura/contratar?plano=slug`.
 *
 * ── O funil estava rompido em dois lugares ────────────────────────────────────
 * 1. O botão "Assinar" da página de planos mandava SEMPRE para `/cadastro`, mesmo
 *    para quem já estava logado. Cliente com conta clicava em assinar e caía numa
 *    tela de criar conta — sem caminho nenhum para o pagamento.
 * 2. O plano escolhido morria no cadastro. O `?plano=` só era usado para escrever
 *    um rótulo na tela ("Plano Essencial — R$ 39,90/mês"); depois de confirmar o
 *    e-mail e entrar, a pessoa era despejada no painel sem nenhuma lembrança do
 *    que tinha escolhido, e precisava descobrir sozinha onde pagar.
 *
 * O resultado é que NINGUÉM conseguia comprar o plano em que clicou. Agora todos
 * os caminhos apontam para cá:
 *   - página de planos, visitante  → /cadastro?plano=X → login → volta para cá
 *   - página de planos, logado     → direto para cá
 *   - link expirado, tentar de novo → recarregar esta página gera outra cobrança
 *
 * Quem não está autenticado é mandado ao login com `next` apontando de volta para
 * cá, então a escolha sobrevive ao cadastro e ao login.
 *
 * A cobrança é criada no CLIENTE (ver `IrParaPagamento`), não durante o render:
 * cada sessão de checkout é um registro no Asaas, e criar um a cada visita — ou a
 * cada prefetch de link — encheria o painel dele de cobranças abandonadas.
 *
 * O BOLETO desvia daqui para um formulário, e não por gosto de tela: o Checkout
 * hospedado do Asaas não emite boleto, então ele passa pela API de Assinaturas, que
 * exige CPF/CNPJ antes da cobrança. Nos outros métodos quem pede o documento é a
 * página do Asaas; no boleto, somos nós.
 */
export default async function ContratarPage({
  searchParams: searchParamsAsync,
}: {
  searchParams: Promise<{ plano?: string; pacote?: string; metodo?: string }>;
}) {
  const searchParams = await searchParamsAsync;
  const plano = searchParams.plano?.trim();
  const pacote = searchParams.pacote?.trim();
  const metodo = metodoDeTexto(searchParams.metodo);
  /*
    "Escolheu" é diferente de "tem método": `metodoDeTexto` recua no cartão quando
    o parâmetro falta, e era esse recuo silencioso que mandava para o checkout do
    cartão quem nunca escolheu nada — o caso de quem acabava de se cadastrar, que
    chega aqui sem `metodo`. Só o valor explícito e válido conta como escolha.
  */
  const escolheuMetodo = METODOS_DE_PLANO.some((m) => m.valor === searchParams.metodo?.trim());

  if (!plano && !pacote) redirect("/assinatura");

  const destino = plano
    ? `/assinatura/contratar?plano=${encodeURIComponent(plano)}${escolheuMetodo ? `&metodo=${metodo}` : ""}`
    : `/assinatura/contratar?pacote=${encodeURIComponent(pacote!)}`;

  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(destino)}`);

  // Sem escolha feita, a forma de pagamento é o próximo passo — nunca uma decisão
  // tomada por omissão, porque as três não entregam a mesma coisa.
  if (plano && !escolheuMetodo) {
    const registro = await prisma.plan.findUnique({ where: { slug: plano } });
    if (!registro || !registro.active || registro.contactOnly) redirect("/assinatura");
    return (
      <EscolherMetodo
        plano={plano}
        nome={registro.name}
        preco={precoBR(registro.priceCents)}
        anual={registro.period === "ANUAL"}
      />
    );
  }

  if (plano && metodo === "boleto") {
    const registro = await prisma.plan.findUnique({ where: { slug: plano } });
    // Plano inexistente ou desativado volta para a assinatura em vez de mostrar um
    // formulário que só falharia no envio.
    if (!registro || !registro.active || registro.contactOnly) redirect("/assinatura");
    return <ContratarBoleto plano={plano} nome={registro.name} preco={precoBR(registro.priceCents)} />;
  }

  // Crédito avulso não passa por método: o checkout dele aceita PIX e cartão juntos.
  return <IrParaPagamento plano={plano} pacote={pacote} metodo={pacote ? undefined : (metodo as "cartao" | "pix")} />;
}
