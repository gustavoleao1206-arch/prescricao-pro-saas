import Link from "next/link";
import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { saldoDe } from "@/lib/credits";
import { brl, dateBR, periodLabel } from "@/lib/format";
import { calcularProporcional, planoTrocavel } from "@/lib/mudanca-plano";
import { ChangePlan, type OpcaoDePlano } from "@/components/app/change-plan";

export const dynamic = "force-dynamic";

/**
 * Tela de mudança de plano.
 *
 * Existe porque trocar de plano só era possível passando pelo checkout de novo — o
 * que cobrava o valor CHEIO do plano novo em cima do mês já pago e criava uma
 * segunda cobrança recorrente ao lado da antiga. Aqui o upgrade cobra apenas a
 * diferença proporcional aos dias restantes, e o downgrade não cobra nada.
 *
 * Todo o cálculo é feito no servidor: o valor que aparece no cartão é o mesmo que
 * a cobrança usa. Ver src/lib/mudanca-plano.ts.
 */
export default async function MudarPlanoPage() {
  const ctx = await getAppContext();
  if (!ctx) redirect("/login");

  const sub = ctx.currentSubscription;
  const atual = sub ? await prisma.plan.findUnique({ where: { id: sub.planId } }) : null;
  const saldo = saldoDe(sub);

  // Motivos para a troca automática não estar disponível. Cada um leva a um texto
  // próprio: "não dá" sem explicar o quê é o que gera chamado de suporte.
  const semAssinatura = !sub || sub.status !== "ATIVA";
  const foraDoAsaas = !semAssinatura && sub!.provider !== "ASAAS";
  const planoAtualNaoTrocavel = !semAssinatura && !foraDoAsaas && !!atual && !planoTrocavel(atual);
  const indisponivel = semAssinatura || foraDoAsaas || planoAtualNaoTrocavel;

  let opcoes: OpcaoDePlano[] = [];
  let agendado: { nome: string; quando: Date | null } | null = null;

  if (!indisponivel && sub && atual) {
    const candidatos = await prisma.plan.findMany({
      where: { active: true, contactOnly: false, id: { not: atual.id } },
      orderBy: { sortOrder: "asc" },
    });

    opcoes = candidatos.filter(planoTrocavel).map((p) => {
      const conta = calcularProporcional(atual, p, sub);
      return {
        slug: p.slug,
        nome: p.name,
        precoCents: p.priceCents,
        creditosDoPlano: p.monthlyAnalyses,
        ehUpgrade: conta.ehUpgrade,
        valorCents: conta.valorCents,
        creditosAdicionais: conta.creditosAdicionais,
        cobrancaDispensada: conta.cobrancaDispensada,
        diasRestantes: conta.diasRestantes,
        valeApartirDeTexto: conta.valeApartirDe ? dateBR(conta.valeApartirDe) : null,
        mudaPeriodo: conta.mudaPeriodo,
        creditoDoCicloAtualCents: conta.creditoDoCicloAtualCents,
      };
    });

    if (sub.pendingPlanId) {
      const pendente = await prisma.plan.findUnique({ where: { id: sub.pendingPlanId } });
      if (pendente) agendado = { nome: pendente.name, quando: sub.pendingPlanAt };
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/assinatura" className="text-sm text-neutro-500 underline">
          ← Voltar para Minha assinatura
        </Link>
        <h1 className="mt-2 text-2xl">Mudar de plano</h1>
      </div>

      {/* Onde o cliente está hoje: sem isso, comparar planos é adivinhação. */}
      {sub && atual && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="card p-5">
            <div className="text-xs uppercase text-neutro-400">Plano atual</div>
            <div className="mt-1 text-lg font-bold text-marinho-700">{atual.name}</div>
            <div className="text-xs text-neutro-400">
              {brl(atual.priceCents)}
              {periodLabel(atual.period)}
            </div>
          </div>
          <div className="card p-5">
            <div className="text-xs uppercase text-neutro-400">Créditos deste ciclo</div>
            <div className="mt-1 text-lg font-bold text-marinho-700">
              {saldo.ilimitado ? "Sem limite" : String(saldo.total)}
            </div>
            <div className="text-xs text-neutro-400">
              {saldo.ilimitado ? "plano sem limite" : `${saldo.usadosNoCiclo} de ${saldo.cotaMensal} utilizados`}
            </div>
          </div>
          <div className="card p-5">
            <div className="text-xs uppercase text-neutro-400">Ciclo pago até</div>
            <div className="mt-1 text-lg font-bold text-marinho-700">{dateBR(sub.currentPeriodEnd)}</div>
            <div className="text-xs text-neutro-400">base do cálculo proporcional</div>
          </div>
        </div>
      )}

      {agendado && (
        <div className="rounded-xl border border-atencao-100 bg-atencao-50 p-4 text-sm text-atencao">
          Já existe uma mudança agendada para <strong>{agendado.nome}</strong>
          {agendado.quando ? `, a partir de ${dateBR(agendado.quando)}` : ""}. Escolher outro plano abaixo substitui
          este agendamento.
        </div>
      )}

      {semAssinatura ? (
        <div className="card p-5 text-sm text-neutro-600">
          <p className="font-semibold text-marinho-700">Você não tem assinatura ativa.</p>
          <p className="mt-1">
            A mudança de plano compara o que você já pagou com o plano novo, então precisa de uma assinatura em
            vigor.{" "}
            <Link href="/assinatura" className="underline">
              Ver minha assinatura
            </Link>
            .
          </p>
        </div>
      ) : foraDoAsaas ? (
        <div className="card p-5 text-sm text-neutro-600">
          <p className="font-semibold text-marinho-700">Esta assinatura muda de plano pelo atendimento.</p>
          <p className="mt-1">
            Ela não foi contratada pelo pagamento online desta plataforma, então a diferença proporcional não pode
            ser cobrada automaticamente.{" "}
            <Link href="/suporte" className="underline">
              Falar com o suporte
            </Link>{" "}
            — a troca é feita sem custo de intermediação.
          </p>
        </div>
      ) : planoAtualNaoTrocavel ? (
        <div className="card p-5 text-sm text-neutro-600">
          <p className="font-semibold text-marinho-700">Seu plano atual é tratado pelo atendimento.</p>
          <p className="mt-1">
            Planos sob contrato e planos sem limite de créditos têm condições próprias e não entram no cálculo
            automático.{" "}
            <Link href="/suporte" className="underline">
              Falar com o suporte
            </Link>
            .
          </p>
        </div>
      ) : (
        <>
          <div className="card p-5">
            <h2 className="text-base font-semibold text-marinho-700">Como funciona a conta</h2>
            <ul className="mt-2 space-y-1 text-sm text-neutro-600">
              <li>
                <strong>Subir de plano:</strong> você paga apenas a diferença entre os dois planos, proporcional aos
                dias que faltam do ciclo já pago. Os créditos a mais entram na hora e o que você já usou continua
                valendo.
              </li>
              <li>
                <strong>Descer de plano:</strong> nada é cobrado agora. Você fica com o plano atual e os créditos
                deste ciclo até o fim do período pago; o valor menor passa a ser cobrado na renovação.
              </li>
              <li>
                Créditos do plano valem dentro do ciclo. Créditos avulsos comprados à parte têm validade própria e
                não são afetados pela troca.
              </li>
            </ul>
          </div>

          <ChangePlan opcoes={opcoes} />
        </>
      )}

      <p className="text-xs text-neutro-400">
        Condições completas em{" "}
        <Link href="/politica-de-assinatura" className="underline">
          Política de assinatura
        </Link>
        . Dúvidas?{" "}
        <Link href="/suporte" className="underline">
          Suporte
        </Link>
        .
      </p>
    </div>
  );
}
