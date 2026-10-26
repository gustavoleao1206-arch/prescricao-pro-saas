"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Acao = "suspender" | "reativar" | "cancelar" | "restabelecer" | "prorrogar-revisao" | "interromper-cobranca";

/**
 * Ações do admin sobre uma assinatura.
 *
 * ── "Liberar" e "Restabelecer" não são a mesma coisa ──────────────────────────
 * "Liberar" (reativar) soma um CICLO INTEIRO ao período pago: é concessão comercial.
 * "Restabelecer" devolve o acesso sem tocar no período — é o que os Termos e a
 * Política de Cancelamento prometem para a revisão de estorno, e usar "Liberar" nesse
 * caso presentearia o cliente com um mês e faria a data da próxima cobrança mentir.
 * Por isso o botão de restabelecer só aparece em SUSPENSA e ESTORNADA, e o de liberar
 * sai de cena nesses dois estados: eram a mesma tecla para dois atos diferentes.
 */
export function AdminSubscriptionActions({
  id,
  status,
  prazoRevisao,
  revisaoProrrogada,
  suspensaEm,
}: {
  id: string;
  status: string;
  /**
   * Vencimento da revisão de CONTESTAÇÃO, em ISO. Nulo em suspensão administrativa —
   * aquele prazo é da contestação de cobrança e não se aplica à sanção.
   */
  prazoRevisao?: string | null;
  revisaoProrrogada?: boolean;
  /** Desde quando o acesso está suspenso, para a linha dizer o que é verdade. */
  suspensaEm?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [painel, setPainel] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);

  async function act(action: Acao) {
    if (
      action === "cancelar" &&
      !confirm(
        "Cancelar esta assinatura?\n\n" +
          "• A cobrança recorrente é encerrada no Asaas (não haverá novos débitos).\n" +
          "• O acesso é mantido até o fim do período já pago.\n" +
          "• O cliente é avisado por e-mail.",
      )
    ) {
      return;
    }
    if (
      action === "interromper-cobranca" &&
      !confirm(
        "Interromper a cobrança desta assinatura?\n\n" +
          "• A recorrência é encerrada no Asaas (não haverá novos débitos).\n" +
          "• O estado da assinatura e o prazo da revisão NÃO mudam.\n" +
          "• O acesso não é alterado por esta ação.",
      )
    ) {
      return;
    }
    if (
      action === "restabelecer" &&
      !confirm(
        "Restabelecer o acesso desta assinatura?\n\n" +
          "O período pago NÃO é estendido e os créditos bloqueados são devolvidos. O cliente é avisado por e-mail.",
      )
    ) {
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/assinaturas/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      /**
       * A resposta é sempre exibida. Ela diz o que aconteceu com crédito, com
       * e-mail e — no cancelamento — se a cobrança foi de fato interrompida no Asaas.
       * Engolir isso era o que permitia ao admin acreditar que havia cancelado
       * enquanto o cartão do cliente continuava sendo debitado.
       */
      setMsg({ ok: res.ok, texto: data.data?.message ?? data.error ?? "Ação concluída." });
      router.refresh();
    } catch {
      setMsg({ ok: false, texto: "Falha de conexão." });
    } finally {
      setBusy(false);
    }
  }

  const active = status === "ATIVA" || status === "TESTE";
  /** Bloqueado: as duas saídas (restabelecer, interromper cobrança) valem para os dois. */
  const bloqueada = status === "SUSPENSA" || status === "ESTORNADA";
  /**
   * Só a contestação tem prazo com efeito automático. A suspensão administrativa exibia o
   * mesmo prazo e a mesma frase de restabelecimento automático — promessa que nunca foi
   * cumprida, porque a varredura só alcança ESTORNADA. Ver `prazoDaRevisao`.
   */
  const emContestacao = status === "ESTORNADA";
  const prazo = prazoRevisao ? new Date(prazoRevisao) : null;
  const vencido = prazo !== null && prazo < new Date();
  const suspensaDesde = suspensaEm ? new Date(suspensaEm) : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {active && (
          <button disabled={busy} onClick={() => act("suspender")} className="text-xs font-medium text-atencao hover:underline">Suspender</button>
        )}
        {bloqueada ? (
          <button disabled={busy} onClick={() => act("restabelecer")} className="text-xs font-medium text-sucesso hover:underline">
            Restabelecer acesso
          </button>
        ) : (
          !active && (
            <button disabled={busy} onClick={() => act("reativar")} className="text-xs font-medium text-sucesso hover:underline">
              Liberar (+1 ciclo)
            </button>
          )
        )}
        {/*
          Interromper a cobrança aparece nos dois estados BLOQUEADOS, porque é neles que não
          há outra saída: o cliente não consegue entrar na conta para cancelar (o login é
          recusado), e "Cancelar" pelo painel é recusado ali — em ESTORNADA porque destruiria
          o prazo da revisão. Sem este botão ele ficava bloqueado e sendo cobrado todo mês.
        */}
        {bloqueada && (
          <button disabled={busy} onClick={() => act("interromper-cobranca")} className="text-xs font-medium text-atencao hover:underline">
            Interromper cobrança
          </button>
        )}
        {emContestacao && !revisaoProrrogada && (
          <button disabled={busy} onClick={() => act("prorrogar-revisao")} className="text-xs font-medium text-marinho-700 hover:underline">
            Prorrogar revisão
          </button>
        )}
        {active && (
          <button disabled={busy} onClick={() => act("cancelar")} className="text-xs font-medium text-alerta-700 hover:underline">Cancelar</button>
        )}
        <button onClick={() => setPainel((v) => !v)} className="text-xs font-medium text-marca-600 hover:underline dark:text-marca-300">
          {painel ? "Fechar créditos" : "Créditos"}
        </button>
      </div>

      {/*
        O prazo aparece na linha da assinatura porque é ele que obriga: vencido sem
        decisão, o acesso volta sozinho na manutenção diária, e o estorno fica sem
        contrapartida. Mostrar a data é o que transforma a cláusula em algo que o
        admin consegue cumprir.
      */}
      {emContestacao && prazo && (
        <p className={`text-xs ${vencido ? "font-semibold text-alerta-700" : "text-neutro-500"}`}>
          {vencido ? "Prazo da revisão VENCIDO em " : "Revisão até "}
          {prazo.toLocaleDateString("pt-BR")}
          {revisaoProrrogada ? " (prorrogada)" : ""}
          {vencido ? " — o acesso é restabelecido automaticamente." : ""}
        </p>
      )}

      {/*
        Suspensão administrativa: nenhum prazo devolve o acesso, e a linha diz isso. Antes
        ela exibia o prazo da contestação e prometia restabelecimento automático — o que
        levava a acreditar que um prazo obrigava quando ele não obrigava.
      */}
      {status === "SUSPENSA" && (
        <p className="text-xs text-neutro-500">
          Suspensa{suspensaDesde ? ` desde ${suspensaDesde.toLocaleDateString("pt-BR")}` : ""} por decisão
          administrativa. O acesso <strong>não volta por prazo</strong> nem por novo pagamento: volta em
          &ldquo;Restabelecer acesso&rdquo;, cessada a causa.
        </p>
      )}
      {msg && <p className={`text-xs ${msg.ok ? "text-sucesso" : "text-alerta-700"}`}>{msg.texto}</p>}
      {painel && <CreditosAdmin id={id} onDone={() => router.refresh()} />}
    </div>
  );
}

/**
 * Painel de crédito manual. Todo lançamento exige motivo, o backend recusa sem
 * ele, porque um extrato sem justificativa não serve para auditar depois.
 */
function CreditosAdmin({ id, onDone }: { id: string; onDone: () => void }) {
  const [acao, setAcao] = useState<"liberar" | "estornar" | "bonus" | "renovar-ciclo">("liberar");
  const [creditos, setCreditos] = useState(1);
  const [motivo, setMotivo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);

  const precisaQuantidade = acao !== "renovar-ciclo";

  async function enviar() {
    setMsg(null);
    if (motivo.trim().length < 3) {
      setMsg({ ok: false, texto: "Informe o motivo (mínimo 3 caracteres)." });
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { action: acao, motivo };
      if (precisaQuantidade) body.creditos = creditos;
      const res = await fetch(`/api/admin/assinaturas/${id}/creditos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setMsg({ ok: true, texto: "Movimentação registrada." });
        setMotivo("");
        onDone();
      } else {
        setMsg({ ok: false, texto: data.error ?? "Não foi possível registrar." });
      }
    } catch {
      setMsg({ ok: false, texto: "Falha de conexão." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-64 space-y-2 rounded-xl border border-neutro-200 bg-neutro-50 p-3">
      <select
        value={acao}
        onChange={(e) => setAcao(e.target.value as typeof acao)}
        className="w-full rounded-lg border border-neutro-300 bg-white px-2 py-1.5 text-xs text-marinho-700"
      >
        <option value="liberar">Liberar créditos</option>
        <option value="estornar">Estornar créditos</option>
        <option value="bonus">Bônus promocional</option>
        <option value="renovar-ciclo">Renovar ciclo do plano</option>
      </select>
      {precisaQuantidade && (
        <input
          type="number"
          min={1}
          value={creditos}
          onChange={(e) => setCreditos(Math.max(1, Number(e.target.value)))}
          className="w-full rounded-lg border border-neutro-300 bg-white px-2 py-1.5 text-xs"
          placeholder="Créditos"
        />
      )}
      <input
        type="text"
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        className="w-full rounded-lg border border-neutro-300 bg-white px-2 py-1.5 text-xs"
        placeholder="Motivo (obrigatório)"
      />
      <button disabled={busy} onClick={enviar} className="btn-primary w-full justify-center py-1.5 text-xs">
        {busy ? "Registrando…" : "Aplicar"}
      </button>
      {msg && (
        <p className={`text-xs ${msg.ok ? "text-sucesso" : "text-alerta-700"}`}>{msg.texto}</p>
      )}
    </div>
  );
}
