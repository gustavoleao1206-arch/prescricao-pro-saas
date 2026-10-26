import Link from "next/link";
import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { SubscriptionStatusBadge } from "@/components/ui/badge";
import { SubscriptionActions } from "@/components/app/subscription-actions";
import { BuyCreditPack } from "@/components/app/buy-credit-pack";
import { saldoDe } from "@/lib/credits";
import { brl, dateBR, periodLabel } from "@/lib/format";
import { planoTrocavel } from "@/lib/mudanca-plano";
import { PLANOS } from "@/lib/planos";
import { renovacaoDe } from "@/lib/renovacao";

export const dynamic = "force-dynamic";

/**
 * Situação do pagamento em palavras que o cliente entende.
 *
 * A tabela exibia o valor cru do banco. Enquanto os estados eram só APROVADO e
 * ESTORNADO isso passava; deixou de passar quando PENDENTE começou a ser usado para
 * uma coisa muito específica — quantia que entrou, NÃO gerou acesso e será devolvida
 * (cobrança que caiu depois do cancelamento, ver `cobrancaDepoisDoCancelamento`).
 * Para quem lê o extrato, "pendente" significa o contrário: "eu devo alguma coisa".
 * Palavra errada aqui produz exatamente o telefonema que o aviso por e-mail tenta
 * evitar.
 */
const SITUACAO_DO_PAGAMENTO: Record<string, string> = {
  APROVADO: "Pago",
  PENDENTE: "A devolver",
  ESTORNADO: "Estornado",
  RECUSADO: "Recusado",
  CHARGEBACK: "Contestado",
  CANCELADO: "Cancelado",
};

/**
 * Retorno do checkout do Asaas.
 *
 * As três URLs de callback (`successUrl`, `cancelUrl`, `expiredUrl` em
 * `criarCheckout`) trazem o cliente de volta para cá com `?status=`, e a página
 * ignorava esse parâmetro por completo. Quem tivesse a sessão de checkout expirada
 * — ela dura 60 minutos — voltava para uma tela idêntica à de antes, sem uma
 * palavra sobre o que aconteceu nem como tentar de novo. Foi exatamente o que
 * aconteceu no primeiro teste real de pagamento.
 */
const RETORNOS = {
  sucesso: {
    tom: "sucesso" as const,
    titulo: "Pagamento recebido.",
    texto:
      "A liberação do acesso acontece na confirmação do provedor, o que costuma levar alguns instantes. " +
      "Se os créditos não aparecerem aqui em poucos minutos, avise o suporte.",
  },
  cancelado: {
    tom: "atencao" as const,
    titulo: "Pagamento não concluído.",
    texto: "Nada foi cobrado. Você pode tentar de novo quando quiser.",
  },
  expirado: {
    tom: "atencao" as const,
    titulo: "O prazo do pagamento expirou.",
    texto:
      "A tela de pagamento fica válida por 60 minutos. Nada foi cobrado — gere uma nova cobrança no botão abaixo.",
  },
};

export default async function AssinaturaPage({ searchParams: searchParamsAsync }: { searchParams?: Promise<{ status?: string }> }) {
  const searchParams = await searchParamsAsync;
  const ctx = await getAppContext();
  if (!ctx) redirect("/login");

  const retorno = searchParams?.status ? RETORNOS[searchParams.status as keyof typeof RETORNOS] : undefined;

  const sub = ctx.currentSubscription;
  const access = ctx.access;

  const plan = sub ? await prisma.plan.findUnique({ where: { id: sub.planId } }) : null;
  const publicPlan = await prisma.plan.findFirst({ where: { publicPlan: true, active: true }, orderBy: { priceCents: "asc" } });
  const packs = await prisma.creditPack.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } });
  const saldo = saldoDe(sub);
  const payments = sub
    ? await prisma.payment.findMany({ where: { subscriptionId: sub.id }, orderBy: { createdAt: "desc" } })
    : [];
  const lastPaid = payments.find((p) => p.status === "APROVADO");
  /**
   * O último recuo sai do CATÁLOGO, não de um número escrito aqui.
   *
   * Estava fixo em 3990 — o preço do Essencial, plano extinto na reformulação da
   * oferta. O recuo só aparece com o banco sem plano público, e nesse caso ele
   * escreveria "Assinar por R$ 39,90" na tela de quem vai pagar R$ 49,90.
   */
  const planoDeReferencia = PLANOS.find((p) => p.period === "MENSAL") ?? PLANOS[0]!;
  const priceCents = plan?.priceCents ?? publicPlan?.priceCents ?? planoDeReferencia.priceCents;
  const period = plan?.period ?? publicPlan?.period ?? planoDeReferencia.period;

  // Troca de plano com cálculo proporcional só existe no pagamento online.
  const podeMudarPlano = !!sub && sub.status === "ATIVA" && sub.provider === "ASAAS" && !!plan && planoTrocavel(plan);
  const pendente = sub?.pendingPlanId
    ? await prisma.plan.findUnique({ where: { id: sub.pendingPlanId }, select: { name: true } })
    : null;

  // CTA principal conforme o estado de acesso.
  let primaryLabel: string | undefined;
  if (!access.hasAccess) {
    if (access.action === "assinar") primaryLabel = `Assinar por ${brl(priceCents)}${periodLabel(period)}`;
    else if (access.action === "regularizar") primaryLabel = "Regularizar pagamento";
    else if (access.action === "reativar") primaryLabel = "Reativar assinatura";
  } else if (access.inGracePeriod) {
    primaryLabel = "Reativar assinatura";
  }
  /**
   * O botão de cancelar existe para PARAR A COBRANÇA — então aparece sempre que ainda
   * pode haver cobrança a parar.
   *
   * A regra anterior exigia acesso liberado e status ATIVA/TESTE, e escondia o botão
   * exatamente de quem mais precisava dele: o cliente INADIMPLENTE, cuja recorrência
   * segue tentando debitar o cartão todo ciclo, via a tela sem nenhuma saída. Quem já
   * pediu para parar também não precisa do botão de novo. (Em ESTORNADA e SUSPENSA o
   * login é recusado, então nem chega aqui — para esses a saída é a ação
   * "Interromper cobrança" do painel administrativo.)
   */
  const showCancel = Boolean(sub) && sub?.status !== "CANCELADA" && sub?.canceledByRequestAt === null;
  /**
   * Como esta assinatura continua.
   *
   * A regra morava aqui e olhava só `nextRenewalAt`, o que resolvia o PIX (cobrança
   * única: não existe mandato de débito, então não há como cobrar de novo) e errava o
   * CANCELAMENTO — que também zera esse campo. Quem tinha acabado de cancelar no cartão
   * lia "pagamento único, sem renovação automática", como se nunca tivesse assinado uma
   * recorrência. São três estados, e o vocabulário é compartilhado com o painel para as
   * duas telas não divergirem. Ver src/lib/renovacao.ts.
   */
  const renovacao = renovacaoDe(sub, { emTolerancia: access.inGracePeriod });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl">Minha assinatura</h1>

      {/* Retorno do checkout: precisa vir ANTES do estado de acesso, porque é a
          resposta à última ação do cliente. */}
      {retorno && (
        <div
          className={
            retorno.tom === "sucesso"
              ? "rounded-xl border border-sucesso-100 bg-sucesso-50 p-4 text-sm text-sucesso"
              : "rounded-xl border border-atencao-100 bg-atencao-50 p-4 text-sm text-atencao"
          }
        >
          <p className="font-semibold">{retorno.titulo}</p>
          <p className="mt-1">{retorno.texto}</p>
        </div>
      )}

      {/* Banner de estado de acesso */}
      {!access.hasAccess ? (
        <div className="rounded-xl border border-atencao-100 bg-atencao-50 p-4 text-sm text-atencao">
          <p className="font-semibold">{access.message}</p>
          {/* O motivo é o que evita o suporte "por que perdi o acesso?". Vale
              principalmente para o boleto vencido: a assinatura encerra sem nenhuma
              ação do cliente, e sem esta linha ele não tem como saber o porquê. */}
          {sub?.canceledReason && <p className="mt-1">Motivo: {sub.canceledReason}.</p>}
          {access.action === "suporte" && (
            <Link href="/suporte" className="mt-1 inline-block font-semibold underline">Falar com o suporte</Link>
          )}
        </div>
      ) : access.inGracePeriod ? (
        <div className="rounded-xl border border-atencao-100 bg-atencao-50 p-4 text-sm text-atencao">
          {access.message}
        </div>
      ) : (
        <div className="rounded-xl border border-sucesso-100 bg-sucesso-50 p-4 text-sm text-sucesso">
          Assinatura ativa.{" "}
          {renovacao.temProximoCiclo
            ? "Seus créditos são renovados a cada ciclo."
            : "Seus créditos valem até o fim do período contratado."}
        </div>
      )}

      {/* Cartões financeiros */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card p-5">
          <div className="text-xs uppercase text-neutro-400">Plano</div>
          <div className="mt-1 text-lg font-bold text-marinho-700">{plan?.name ?? publicPlan?.name ?? "Prescrição Pro"}</div>
          {sub && <div className="mt-2"><SubscriptionStatusBadge status={sub.status} /></div>}
        </div>
        <div className="card p-5">
          <div className="text-xs uppercase text-neutro-400">{period === "ANUAL" ? "Valor anual" : "Valor mensal"}</div>
          <div className="mt-1 text-lg font-bold text-marinho-700">{brl(priceCents)}<span className="text-sm text-neutro-400">{periodLabel(period)}</span></div>
          <div className="text-xs text-neutro-400">{renovacao.formaDeCobranca}</div>
        </div>
        <div className="card p-5">
          <div className="text-xs uppercase text-neutro-400">{renovacao.rotuloDaData}</div>
          <div className="mt-1 text-lg font-bold text-marinho-700">{dateBR(renovacao.data)}</div>
        </div>
        <div className="card p-5">
          <div className="text-xs uppercase text-neutro-400">Forma de pagamento</div>
          <div className="mt-1 text-lg font-bold text-marinho-700">{lastPaid?.method ?? (sub ? sub.provider : "-")}</div>
        </div>
      </div>

      {/* Ações */}
      <div className="card p-5">
        <h2 className="mb-1 text-base font-semibold">Gerenciar assinatura</h2>
        {/*
          Três textos, porque são três situações. "Encerrando" era descrito como
          "pagamento único, sem renovação automática": quem tinha acabado de cancelar uma
          recorrência no cartão lia como se nunca tivesse assinado uma.
        */}
        <p className="mb-3 text-sm text-neutro-500">
          {renovacao.modo === "renova" ? (
            <>
              Assinatura {period === "ANUAL" ? "anual" : "mensal"} com renovação automática. Cancele quando desejar,
              observadas as condições do período já contratado.
            </>
          ) : renovacao.modo === "encerrando" ? (
            <>
              Assinatura encerrada: <strong>não haverá novas cobranças</strong>. O acesso continua até o fim do período
              já pago{renovacao.data ? `, em ${dateBR(renovacao.data)}` : ""}. Para voltar, basta contratar de novo.
            </>
          ) : (
            <>
              Pagamento único, sem renovação automática: o acesso vale{" "}
              {period === "ANUAL" ? "um ano" : "um mês"} a partir da contratação e encerra ao fim do prazo. Para
              continuar depois, basta contratar de novo — ou assinar no cartão, que renova sozinho.
            </>
          )}
        </p>
        <SubscriptionActions primaryLabel={primaryLabel} showCancel={showCancel} />

        {/* Troca de plano: só aparece quando o cálculo proporcional é possível de
            verdade — assinatura ativa e paga pelo Asaas. Mostrar o link fora
            disso levaria o cliente a uma tela que só sabe dizer "fale com o
            suporte". Ver src/lib/mudanca-plano.ts. */}
        {podeMudarPlano && (
          <div className="mt-4 border-t border-neutro-100 pt-4">
            <Link href="/assinatura/mudar-plano" className="btn-outline text-sm">
              Mudar de plano
            </Link>
            <p className="mt-2 text-xs text-neutro-500">
              Ao subir de plano você paga só a diferença proporcional aos dias restantes do ciclo. Ao descer, nada é
              cobrado agora e a mudança vale na renovação.
            </p>
            {pendente && (
              <p className="mt-2 text-xs text-atencao">
                Mudança para <strong>{pendente.name}</strong> agendada
                {sub?.pendingPlanAt ? ` para ${dateBR(sub.pendingPlanAt)}` : ""}.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Consumo */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="card p-5">
          <div className="text-xs uppercase text-neutro-400">Créditos disponíveis</div>
          <div className="mt-1 text-lg font-bold text-marinho-700">
            {saldo.ilimitado ? "Sem limite" : String(saldo.total)}
          </div>
          <div className="text-xs text-neutro-400">
            {saldo.ilimitado
              ? "plano sem limite de créditos"
              : saldo.saldoAdicional > 0
                ? `${saldo.saldoMensal} do plano + ${saldo.saldoAdicional} adicionais`
                : `${saldo.usadosNoCiclo} de ${saldo.cotaMensal} utilizados neste ciclo`}
          </div>
        </div>
        <div className="card p-5">
          <div className="text-xs uppercase text-neutro-400">Contratação</div>
          <div className="mt-1 text-lg font-bold text-marinho-700">{dateBR(sub?.startedAt)}</div>
          {sub?.canceledAt && <div className="text-xs text-atencao">Cancelada em {dateBR(sub.canceledAt)}</div>}
        </div>
      </div>

      {/* Compra de créditos adicionais */}
      {/*
        Crédito avulso só é oferecido a quem TEM acesso.
        Ele complementa uma assinatura ativa e não dá acesso por si: o gate decide por
        status e prazo antes de olhar saldo. Oferecer a quem está vencido vendia um
        crédito que a primeira análise recusaria, com a validade de 90 dias queimando.
      */}
      {packs.length > 0 && access.hasAccess && (
        <section id="creditos" className="scroll-mt-24">
          <h2 className="mb-1 text-lg">Comprar créditos adicionais</h2>
          <p className="mb-3 text-sm text-neutro-500">
            {renovacao.temProximoCiclo
              ? "Precisou de mais análises antes da renovação? Compre créditos avulsos."
              : "Precisou de mais análises neste período? Compre créditos avulsos."}{" "}
            Os créditos adicionais têm validade de 90 dias e são utilizados depois dos créditos do plano.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {packs.map((pk) => (
              <div key={pk.id} className="card flex flex-col p-5">
                <div className="text-sm font-semibold text-marinho-700">{pk.name}</div>
                <div className="mt-2 text-2xl font-bold text-marca-600 dark:text-marca-300">{brl(pk.priceCents)}</div>
                <div className="mt-1 text-xs text-neutro-500">
                  {pk.credits} {pk.credits === 1 ? "crédito" : "créditos"} · validade de {pk.validityDays} dias
                </div>
                <BuyCreditPack slug={pk.slug} className="btn-outline mt-4 w-full justify-center text-sm" />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Histórico de pagamentos e faturas */}
      <section>
        <h2 className="mb-3 text-lg">Histórico de pagamentos</h2>
        <div className="overflow-x-auto rounded-2xl border border-neutro-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutro-50 text-left text-xs uppercase text-neutro-400">
              <tr><th className="px-4 py-3">Data</th><th className="px-4 py-3">Valor</th><th className="px-4 py-3">Forma</th><th className="px-4 py-3">Origem</th><th className="px-4 py-3">Status</th></tr>
            </thead>
            <tbody className="divide-y divide-neutro-100">
              {payments.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-neutro-500">Nenhum pagamento registrado ainda.</td></tr>
              ) : (
                payments.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-3">{dateBR(p.paidAt ?? p.createdAt)}</td>
                    <td className="px-4 py-3">{brl(p.amountCents)}</td>
                    <td className="px-4 py-3">{p.method ?? "-"}</td>
                    <td className="px-4 py-3">{p.provider}</td>
                    <td className="px-4 py-3">{SITUACAO_DO_PAGAMENTO[p.status] ?? p.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-xs text-neutro-400">
        Dados cadastrais e alteração de senha em <Link href="/configuracoes" className="underline">Configurações</Link>. Dúvidas? <Link href="/suporte" className="underline">Suporte</Link>.
      </p>
    </div>
  );
}
