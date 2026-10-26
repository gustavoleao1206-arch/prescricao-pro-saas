"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Ações do atendimento sobre a análise de um cliente.
 *
 * ── O que não existia ─────────────────────────────────────────────────────────
 * Nenhuma. `/admin/analises` era uma tabela inerte, e a única rota capaz de mudar o status de uma
 * análise não tinha chamador. Diante de uma análise emperrada, a saída do suporte era pedir ao cliente
 * que apagasse e recomeçasse — perdendo os documentos e a análise que ele pagou.
 *
 * ── Cancelar em nome do cliente MOVE O SALDO DELE ─────────────────────────────
 * A mesma regra do fluxo do cliente vale aqui (é a mesma função no servidor): cancelar sem entrega
 * devolve o crédito. Por isso a confirmação diz o nome de quem será afetado — agir sobre a conta de
 * outra pessoa sem ver o nome dela na tela é como se erra o cliente na pressa do atendimento.
 */
export function AcoesDaAnalise({
  id,
  cliente,
  statusAtual,
  acoes,
  statusPossiveis,
}: {
  id: string;
  cliente: string;
  statusAtual: string;
  /** Decidido no servidor, pela mesma função que a rota aplica. */
  acoes: { cancelar: boolean; arquivar: boolean; desarquivar: boolean };
  /** Destinos oferecidos em "forçar": os de execução ficam fora, ninguém os executaria. */
  statusPossiveis: { valor: string; rotulo: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [destino, setDestino] = useState("");
  const [motivo, setMotivo] = useState("");

  async function enviar(corpo: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/analises/${id}/situacao`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
      });
      const dados = await res.json();
      if (res.ok && dados.ok) {
        setMsg(dados.data?.message ?? "Pronto.");
        setMotivo("");
        router.refresh();
      } else {
        setMsg(dados.error ?? "Não foi possível concluir.");
        /**
         * Recarrega na recusa também: as recusas são de ESTADO (a análise mudou, ou está processando
         * agora). Sem isso o botão recusado fica na tela e o atendimento insiste no que não cabe mais.
         */
        router.refresh();
      }
    } catch {
      setMsg("Falha de rede. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  async function acao(qual: "cancelar" | "arquivar" | "desarquivar") {
    if (qual === "cancelar") {
      const pergunta =
        `Cancelar esta análise de ${cliente}?\n\n` +
        "Nada é apagado. E se a análise não chegou a gerar relatório, o crédito volta para o SALDO DO " +
        "CLIENTE — confira se é isso que você quer antes de continuar.";
      if (!confirm(pergunta)) return;
    }
    await enviar({ tipo: "acao", acao: qual });
  }

  async function forcar() {
    if (!destino) return setMsg("Escolha o status de destino.");
    if (motivo.trim().length < 5) return setMsg("Escreva o motivo: ele fica na auditoria.");
    await enviar({ tipo: "forcar", status: destino, motivo });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {acoes.cancelar && (
          <button onClick={() => void acao("cancelar")} disabled={busy} className="btn-ghost px-2 py-1 text-xs text-atencao">
            Cancelar
          </button>
        )}
        {acoes.arquivar && (
          <button onClick={() => void acao("arquivar")} disabled={busy} className="btn-ghost px-2 py-1 text-xs">
            Arquivar
          </button>
        )}
        {acoes.desarquivar && (
          <button onClick={() => void acao("desarquivar")} disabled={busy} className="btn-ghost px-2 py-1 text-xs">
            Desarquivar
          </button>
        )}
      </div>

      {/*
        Forçar status fica FECHADO por padrão, atrás de um clique extra.
        É a ferramenta que ignora as transições normais — deixá-la aberta, ao lado de botões comuns e numa
        tabela de muitas linhas, é convite a clique errado na análise errada.
      */}
      <details className="text-xs">
        <summary className="cursor-pointer text-neutro-400 hover:text-neutro-600">Forçar status…</summary>
        <div className="mt-2 space-y-1 rounded-lg border border-neutro-200 p-2 dark:border-neutro-700">
          <select
            value={destino}
            onChange={(e) => setDestino(e.target.value)}
            className="input w-full py-1 text-xs"
            aria-label="Status de destino"
          >
            <option value="">Status de destino…</option>
            {statusPossiveis
              .filter((s) => s.valor !== statusAtual)
              .map((s) => (
                <option key={s.valor} value={s.valor}>
                  {s.rotulo}
                </option>
              ))}
          </select>
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Motivo (fica na auditoria)"
            className="input w-full py-1 text-xs"
          />
          <button onClick={() => void forcar()} disabled={busy} className="btn-outline w-full py-1 text-xs">
            {busy ? "…" : "Aplicar"}
          </button>
          <p className="text-[11px] leading-tight text-neutro-400">
            Não devolve nem cobra crédito. Para devolver, use Cancelar.
          </p>
        </div>
      </details>

      {msg && <p className="text-xs text-neutro-600 dark:text-neutro-300">{msg}</p>}
    </div>
  );
}
