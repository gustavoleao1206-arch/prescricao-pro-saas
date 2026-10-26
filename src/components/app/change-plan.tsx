"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Escolha do novo plano.
 *
 * A conta (proporcional, créditos, data em que passa a valer) é calculada no
 * servidor e chega pronta em `opcoes`: o cliente precisa ver exatamente o que vai
 * pagar ANTES de clicar, e o valor exibido tem de ser o mesmo que a cobrança usa.
 * Nada de recalcular no navegador.
 *
 * No upgrade pago, o plano NÃO sobe no clique — sobe quando o webhook confirma o
 * pagamento. É o que impede alguém abrir a cobrança, não pagar e ficar com o plano
 * maior.
 */
export interface OpcaoDePlano {
  slug: string;
  nome: string;
  precoCents: number;
  creditosDoPlano: number;
  ehUpgrade: boolean;
  /** Diferença proporcional a pagar agora, em centavos (0 = sem cobrança). */
  valorCents: number;
  creditosAdicionais: number;
  cobrancaDispensada: boolean;
  diasRestantes: number;
  valeApartirDeTexto: string | null;
  /**
   * Muda a periodicidade (mensal ↔ anual) e não a faixa do plano.
   *
   * Com a oferta atual — plano único em duas periodicidades — TODA troca é desta
   * natureza, e a conta é outra: não se paga "a diferença pelos dias restantes",
   * paga-se o período novo abatendo o que sobrou do atual. Sem este sinal a tela
   * explicaria a cobrança errada em 100% dos casos.
   */
  mudaPeriodo: boolean;
  /** Valor não usado do ciclo atual, abatido na troca de periodicidade. */
  creditoDoCicloAtualCents: number;
}

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function ChangePlan({ opcoes }: { opcoes: OpcaoDePlano[] }) {
  const router = useRouter();
  const [emAndamento, setEmAndamento] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);

  async function mudar(op: OpcaoDePlano) {
    setErro(null);
    setSucesso(null);

    const confirmacao = op.ehUpgrade
      ? op.valorCents > 0
        ? op.mudaPeriodo
          ? `Mudar para ${op.nome} agora?\n\nVocê pagará ${brl(op.valorCents)}: o valor do plano (${brl(op.precoCents)}) menos ${brl(op.creditoDoCicloAtualCents)} de crédito pelos ${op.diasRestantes} dia(s) que ainda não usou.\n\nO novo período começa hoje.`
          : `Mudar para ${op.nome} agora?\n\nVocê pagará ${brl(op.valorCents)} pelos ${op.diasRestantes} dia(s) que faltam deste ciclo. A partir da próxima renovação, o valor passa a ser ${brl(op.precoCents)}.`
        : `Mudar para ${op.nome} agora?\n\nSem cobrança neste ciclo. A partir da próxima renovação, o valor passa a ser ${brl(op.precoCents)}.`
      : `Mudar para ${op.nome}?\n\nNada é cobrado agora e você mantém o plano atual e os créditos deste ciclo${op.valeApartirDeTexto ? ` até ${op.valeApartirDeTexto}` : ""}. O plano menor passa a valer na renovação.`;
    if (!window.confirm(confirmacao)) return;

    setEmAndamento(op.slug);
    try {
      const res = await fetch("/api/assinatura/mudar-plano", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planoSlug: op.slug }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErro(data.error ?? "Não foi possível mudar de plano agora.");
        return;
      }
      // Upgrade pago: segue para o pagamento da diferença.
      if (data.data?.tipo === "upgrade" && data.data?.url) {
        window.location.href = data.data.url;
        return;
      }
      setSucesso(data.data?.message ?? "Mudança registrada.");
      router.refresh();
    } catch {
      setErro("Falha de conexão. Tente novamente.");
    } finally {
      setEmAndamento(null);
    }
  }

  if (opcoes.length === 0) {
    return (
      <p className="text-sm text-neutro-500">
        Não há outro plano disponível para troca automática no momento. Fale com o suporte para avaliar as opções.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {sucesso && (
        <p className="rounded-xl border border-sucesso-100 bg-sucesso-50 px-4 py-3 text-sm text-sucesso">{sucesso}</p>
      )}
      {erro && <p className="rounded-xl border border-alerta-100 bg-alerta-50 px-4 py-3 text-sm text-alerta-700">{erro}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {opcoes.map((op) => (
          <div key={op.slug} className="card flex flex-col p-5">
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm font-semibold text-marinho-700">{op.nome}</div>
              <span
                className={
                  op.ehUpgrade
                    ? "badge bg-marca-50 text-marca-700 dark:bg-marca-500/20 dark:text-marca-200"
                    : "badge bg-neutro-100 text-neutro-500"
                }
              >
                {op.ehUpgrade ? "upgrade" : "downgrade"}
              </span>
            </div>

            <div className="mt-2 text-2xl font-bold text-marca-600 dark:text-marca-300">{brl(op.precoCents)}</div>
            <div className="text-xs text-neutro-400">
              {op.mudaPeriodo ? "por período contratado" : "por ciclo, a partir da renovação"}
            </div>
            <div className="mt-1 text-xs text-neutro-500">
              {/* Cota 0 = sem limite. Ver planos-comparador. */}
              {op.creditosDoPlano === 0
                ? "Análises sem limite"
                : `${op.creditosDoPlano} ${op.creditosDoPlano === 1 ? "crédito" : "créditos"} por ciclo`}
            </div>

            {/* A conta desta troca, em texto claro. */}
            <div className="mt-4 flex-1 rounded-xl bg-neutro-50 p-3 text-xs text-neutro-600">
              {op.ehUpgrade ? (
                op.valorCents > 0 ? (
                  <>
                    <div className="font-semibold text-marinho-700">Você paga agora {brl(op.valorCents)}</div>
                    <div className="mt-1">
                      {op.mudaPeriodo ? (
                        <>
                          O valor do plano ({brl(op.precoCents)}) menos {brl(op.creditoDoCicloAtualCents)} de crédito
                          pelos {op.diasRestantes} dia(s) que você ainda não usou. O novo período começa hoje.
                        </>
                      ) : (
                        <>
                          Só a diferença entre os planos, proporcional aos {op.diasRestantes} dia(s) que faltam do
                          ciclo já pago.
                        </>
                      )}
                    </div>
                    {op.creditosAdicionais > 0 && (
                      <div className="mt-1">
                        Recebe {op.creditosAdicionais} crédito(s) a mais neste ciclo, sem perder os que já usou.
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="font-semibold text-marinho-700">Sem cobrança agora</div>
                    <div className="mt-1">
                      {op.cobrancaDispensada
                        ? `Faltam apenas ${op.diasRestantes} dia(s) para a renovação, então a diferença deste ciclo não é cobrada.`
                        : "Não há diferença a cobrar neste ciclo."}
                    </div>
                  </>
                )
              ) : (
                <>
                  <div className="font-semibold text-marinho-700">Nada é cobrado agora</div>
                  <div className="mt-1">
                    Você mantém o plano atual e os créditos deste ciclo
                    {op.valeApartirDeTexto ? ` até ${op.valeApartirDeTexto}` : ""}. O plano menor passa a valer na
                    renovação.
                  </div>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => mudar(op)}
              disabled={emAndamento !== null}
              className={`${op.ehUpgrade ? "btn-primary" : "btn-outline"} mt-4 w-full justify-center text-sm`}
            >
              {emAndamento === op.slug
                ? "Processando…"
                : op.ehUpgrade
                  ? op.valorCents > 0
                    ? `Pagar ${brl(op.valorCents)} e mudar`
                    : "Mudar agora"
                  : "Agendar mudança"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
