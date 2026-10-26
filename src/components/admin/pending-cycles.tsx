"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Assinaturas ativas cujo ciclo do mês corrente ainda não recebeu créditos.
 *
 * O caso que motiva: plano ANUAL é pago uma vez, mas os créditos saem por ciclo
 * mensal. Sem esta lista, saber quem está com o mês pendente era adivinhação — o
 * cliente que pagou 12 meses ficava com saldo zero e ninguém percebia. Aqui dá
 * para ver e liberar com um clique, usando a mesma operação idempotente do cron.
 */

export interface CicloPendenteItem {
  subscriptionId: string;
  organizacao: string;
  cliente: string;
  email: string;
  plano: string;
  periodo: string;
  cotaDoCiclo: number;
  saldoAtual: number;
}

export function PendingCycles({ itens }: { itens: CicloPendenteItem[] }) {
  const router = useRouter();
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [feitos, setFeitos] = useState<Record<string, number>>({});

  async function liberar(item: CicloPendenteItem) {
    setOcupado(item.subscriptionId);
    setErro(null);
    try {
      const res = await fetch(`/api/admin/assinaturas/${item.subscriptionId}/creditos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "renovar-ciclo",
          motivo: `Liberação do ciclo pelo painel de pendências (${item.plano})`,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? "Não foi possível liberar o ciclo.");
      setFeitos((f) => ({ ...f, [item.subscriptionId]: json.data?.liberados ?? item.cotaDoCiclo }));
      router.refresh();
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setOcupado(null);
    }
  }

  if (!itens.length) {
    return (
      <div className="card p-4 text-sm text-neutro-500">
        Nenhuma assinatura com ciclo pendente neste mês — todos os clientes ativos já receberam os créditos.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-atencao-100 bg-atencao-50 p-3 text-sm text-atencao dark:border-atencao/40 dark:bg-atencao/10">
        <strong>{itens.length} assinatura(s) ativa(s) sem os créditos deste mês.</strong> A manutenção diária libera
        sozinha as do plano <strong>anual</strong>, no dia do contrato de cada uma. As do plano <strong>mensal</strong>
        aparecem aqui durante o intervalo normal entre pagamentos — elas recebem a cota quando a cobrança do mês é
        confirmada, e liberar à mão antes disso <strong>adianta a cota de graça</strong> e faz a liberação legítima do
        pagamento ser ignorada, porque a chave do mês já foi usada. Antes de clicar, confira a coluna do plano.
        Liberar é idempotente — clicar duas vezes não dobra a cota.
      </div>

      <div className="overflow-x-auto rounded-2xl border border-neutro-200 bg-white dark:border-neutro-700 dark:bg-neutro-900">
        <table className="w-full text-sm">
          <thead className="bg-neutro-50 text-left text-xs uppercase text-neutro-400 dark:bg-neutro-800">
            <tr>
              <th className="px-4 py-3">Cliente</th>
              <th className="px-4 py-3">Plano</th>
              <th className="px-4 py-3">Cota do ciclo</th>
              <th className="px-4 py-3">Saldo hoje</th>
              <th className="px-4 py-3">Ação</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutro-100 dark:divide-neutro-800">
            {itens.map((i) => (
              <tr key={i.subscriptionId}>
                <td className="px-4 py-3">
                  <div className="font-medium text-marinho-700 dark:text-neutro-100">{i.organizacao}</div>
                  <div className="text-xs text-neutro-400">
                    {i.cliente} · {i.email}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {i.plano}
                  <span className="ml-1 text-xs text-neutro-400">({i.periodo === "ANUAL" ? "anual" : "mensal"})</span>
                </td>
                <td className="px-4 py-3">{i.cotaDoCiclo}</td>
                <td className="px-4 py-3">
                  <span className={i.saldoAtual === 0 ? "font-semibold text-atencao" : "text-neutro-500"}>
                    {i.saldoAtual}
                    {i.saldoAtual === 0 && " — sem saldo"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {feitos[i.subscriptionId] !== undefined ? (
                    <span className="text-xs font-medium text-sucesso">
                      {feitos[i.subscriptionId]} liberado(s) ✓
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => liberar(i)}
                      disabled={ocupado !== null}
                      className="rounded-lg border border-neutro-300 bg-white px-2.5 py-1.5 text-xs font-medium text-marinho-700 hover:border-marca-400 disabled:opacity-40 dark:border-neutro-600 dark:bg-neutro-800 dark:text-neutro-100"
                    >
                      {ocupado === i.subscriptionId ? "Liberando…" : "Liberar ciclo"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {erro && (
        <p className="rounded-xl border border-atencao-100 bg-atencao-50 p-3 text-sm text-atencao dark:border-atencao/40 dark:bg-atencao/10">
          {erro}
        </p>
      )}
    </div>
  );
}
