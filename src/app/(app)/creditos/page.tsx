import Link from "next/link";
import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/tenant";
import { extratoDeCreditos, saldoDe, ROTULO_MOVIMENTO } from "@/lib/credits";
import { dateBR } from "@/lib/format";
import type { CreditMovementKind } from "@prisma/client";

export const dynamic = "force-dynamic";

/**
 * Extrato de créditos.
 *
 * Mostra saldo anterior e posterior de cada movimentação porque é isso que
 * permite ao cliente conferir a conta sozinho, sem isso, "sumiu um crédito"
 * vira um chamado de suporte que ninguém consegue responder.
 */
export default async function CreditosPage() {
  const ctx = await getAppContext();
  if (!ctx) redirect("/login");

  const sub = ctx.currentSubscription;
  const saldo = saldoDe(sub);
  const movimentos = sub ? await extratoDeCreditos(sub.id, 200) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl">Histórico de créditos</h1>
          <p className="mt-1 text-sm text-neutro-500">
            Cada movimentação da sua conta, com o saldo antes e depois.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/assinatura#creditos" className="btn-primary text-sm">Comprar créditos</Link>
          <Link href="/painel" className="btn-ghost text-sm">Voltar ao painel</Link>
        </div>
      </div>

      {!sub ? (
        <div className="card p-6 text-sm text-neutro-500">
          Você ainda não possui assinatura.{" "}
          <Link href="/planos" className="font-medium text-marca-600 underline dark:text-marca-300">
            Escolha um plano
          </Link>{" "}
          para começar.
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Resumo rotulo="Saldo total" valor={saldo.ilimitado ? "Sem limite" : String(saldo.total)} destaque />
            <Resumo rotulo="Créditos do plano" valor={saldo.ilimitado ? "-" : `${saldo.saldoMensal} de ${saldo.cotaMensal}`} />
            <Resumo rotulo="Créditos adicionais" valor={String(saldo.saldoAdicional)} />
          </div>

          <div className="card overflow-x-auto">
            {movimentos.length === 0 ? (
              <p className="p-6 text-sm text-neutro-500">Nenhuma movimentação registrada ainda.</p>
            ) : (
              <table className="w-full min-w-[46rem] text-sm">
                <thead>
                  <tr className="border-b border-neutro-200 text-left text-xs uppercase tracking-wide text-neutro-400">
                    <th className="px-4 py-3 font-medium">Data</th>
                    <th className="px-4 py-3 font-medium">Movimentação</th>
                    <th className="px-4 py-3 font-medium">Descrição</th>
                    <th className="px-4 py-3 text-right font-medium">Créditos</th>
                    <th className="px-4 py-3 text-right font-medium">Saldo anterior</th>
                    <th className="px-4 py-3 text-right font-medium">Saldo posterior</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutro-100">
                  {movimentos.map((m) => (
                    <tr key={m.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-3 text-neutro-600">{dateBR(m.createdAt)}</td>
                      <td className="px-4 py-3">
                        <span className="font-medium text-marinho-700">
                          {ROTULO_MOVIMENTO[m.kind as CreditMovementKind]}
                        </span>
                        {m.expiresAt && (
                          <span className="mt-0.5 block text-xs text-neutro-500">
                            Validade: {dateBR(m.expiresAt)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-neutro-600">
                        {m.analysis ? (
                          <Link
                            href={`/analises/${m.analysis.id}`}
                            className="font-medium text-marca-600 underline dark:text-marca-300"
                          >
                            {m.analysis.title}
                          </Link>
                        ) : (
                          m.description
                        )}
                        {/* Ajuste manual sem o motivo à vista é extrato que não
                            explica nada, mostra a justificativa junto. */}
                        {m.reason && <span className="mt-0.5 block text-xs text-neutro-500">{m.reason}</span>}
                        {m.actor && <span className="block text-xs text-neutro-400">Lançado por {m.actor.name}</span>}
                      </td>
                      <td
                        className={`whitespace-nowrap px-4 py-3 text-right font-semibold ${
                          m.quantity > 0 ? "text-sucesso" : m.quantity < 0 ? "text-alerta-700" : "text-neutro-500"
                        }`}
                      >
                        {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right text-neutro-500">{m.balanceBefore}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-marinho-700">
                        {m.balanceAfter}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <p className="text-xs text-neutro-500">
            Os créditos do plano são liberados a cada ciclo e não acumulam. Créditos avulsos comprados
            têm validade de 90 dias e são utilizados depois dos créditos do plano.
          </p>
        </>
      )}
    </div>
  );
}

function Resumo({ rotulo, valor, destaque = false }: { rotulo: string; valor: string; destaque?: boolean }) {
  return (
    <div className="card p-5">
      <div className="text-xs font-medium uppercase tracking-wide text-neutro-400">{rotulo}</div>
      <div className={`mt-2 font-bold ${destaque ? "text-2xl text-marca-600 dark:text-marca-300" : "text-xl text-marinho-700"}`}>
        {valor}
      </div>
    </div>
  );
}
