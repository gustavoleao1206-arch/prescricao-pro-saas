"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Painel de revisão do advogado responsável.
 *
 * A análise é apoio: a conclusão só vale depois que um(a) advogado(a) confere.
 * Registrar quem conferiu, quando e com quais ressalvas é o que transforma
 * esse dever em prova de diligência, e é o que faltava para a análise sair
 * de "aguardando revisão".
 */

export interface RevisaoAtual {
  status: "PENDENTE" | "EM_ANALISE" | "APROVADA" | "DEVOLVIDA";
  notes: string | null;
  risks: string | null;
  divergences: string | null;
  decidedAt: string | null;
  revisor: string | null;
}

export function ReviewPanel({ analysisId, revisao }: { analysisId: string; revisao: RevisaoAtual }) {
  const router = useRouter();
  const [aberto, setAberto] = useState(revisao.status === "PENDENTE");

  // O painel é remontado pelo servidor após router.refresh(), mas o React
  // preserva o estado do cliente, sem isto, confirmar a revisão deixava o
  // formulário aberto como se nada tivesse acontecido. Ajustar o estado
  // durante a renderização é o padrão do React para "props mudaram".
  const [statusVisto, setStatusVisto] = useState(revisao.status);
  if (statusVisto !== revisao.status) {
    setStatusVisto(revisao.status);
    setAberto(revisao.status === "PENDENTE");
  }

  const [notes, setNotes] = useState(revisao.notes ?? "");
  const [risks, setRisks] = useState(revisao.risks ?? "");
  const [divergences, setDivergences] = useState(revisao.divergences ?? "");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState<"APROVADA" | "DEVOLVIDA" | null>(null);

  async function decidir(decisao: "APROVADA" | "DEVOLVIDA") {
    if (enviando) return;
    setEnviando(decisao);
    setErro(null);
    try {
      const res = await fetch(`/api/analises/${analysisId}/revisao`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisao, notes, risks, divergences }),
      });
      const dados = await res.json();
      if (!res.ok || !dados.ok) {
        setErro(dados.error ?? "Não foi possível registrar a revisão.");
        return;
      }
      router.refresh();
    } catch {
      setErro("Não foi possível registrar a revisão. Tente novamente.");
    } finally {
      setEnviando(null);
    }
  }

  if (revisao.status !== "PENDENTE" && !aberto) {
    return <Concluida revisao={revisao} onReabrir={() => setAberto(true)} />;
  }

  return (
    <section className="card p-5">
      <h2 className="text-base font-semibold text-marinho-700">Revisão do advogado</h2>
      <p className="mt-1 text-sm text-neutro-600">
        Confira a conclusão, o cálculo do prazo e as datas contra os autos. Registre suas ressalvas:
        elas ficam gravadas com seu nome e a data.
      </p>

      <div className="mt-4 space-y-3">
        <Campo
          rotulo="Observações da revisão"
          valor={notes}
          onChange={setNotes}
          dica="O que você conferiu e o que concluiu."
        />
        <Campo
          rotulo="Divergências em relação à análise"
          valor={divergences}
          onChange={setDivergences}
          dica="Pontos em que a leitura automática não corresponde aos autos."
        />
        <Campo
          rotulo="Riscos identificados"
          valor={risks}
          onChange={setRisks}
          dica="O que pode enfraquecer a tese ou sustentar a defesa da Fazenda."
        />
      </div>

      {erro && <p role="alert" className="mt-3 rounded-lg bg-alerta-50 px-3 py-2 text-sm text-alerta-700">{erro}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => void decidir("APROVADA")} disabled={enviando !== null} className="btn-primary text-sm">
          {enviando === "APROVADA" ? "Registrando…" : "Confirmar revisão"}
        </button>
        <button type="button" onClick={() => void decidir("DEVOLVIDA")} disabled={enviando !== null} className="btn-outline text-sm">
          {enviando === "DEVOLVIDA" ? "Registrando…" : "Precisa de complementação"}
        </button>
      </div>
      <p className="mt-3 text-xs text-neutro-500">
        <strong>Confirmar revisão</strong> conclui a análise. <strong>Precisa de complementação</strong> a
        devolve para você anexar documentos e reprocessar.
      </p>
    </section>
  );
}

function Concluida({ revisao, onReabrir }: { revisao: RevisaoAtual; onReabrir: () => void }) {
  const aprovada = revisao.status === "APROVADA";
  return (
    <section className={`rounded-2xl border p-5 ${aprovada ? "border-sucesso/30 bg-sucesso-50 dark:bg-sucesso/10" : "border-atencao-100 bg-atencao-50 dark:bg-atencao/10"}`}>
      <h2 className={`text-base font-semibold ${aprovada ? "text-sucesso" : "text-atencao"}`}>
        {aprovada ? "Revisada e concluída" : "Devolvida para complementação"}
      </h2>
      <p className="mt-1 text-xs text-neutro-500">
        {revisao.revisor ?? "-"}
        {revisao.decidedAt ? ` · ${new Date(revisao.decidedAt).toLocaleString("pt-BR")}` : ""}
      </p>
      {revisao.notes && <Bloco titulo="Observações" texto={revisao.notes} />}
      {revisao.divergences && <Bloco titulo="Divergências" texto={revisao.divergences} />}
      {revisao.risks && <Bloco titulo="Riscos" texto={revisao.risks} />}
      <button type="button" onClick={onReabrir} className="btn-ghost mt-3 text-sm">
        Revisar novamente
      </button>
    </section>
  );
}

function Bloco({ titulo, texto }: { titulo: string; texto: string }) {
  return (
    <div className="mt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutro-500">{titulo}</h3>
      <p className="whitespace-pre-line text-sm text-neutro-700">{texto}</p>
    </div>
  );
}

function Campo({
  rotulo, valor, onChange, dica,
}: { rotulo: string; valor: string; onChange: (v: string) => void; dica: string }) {
  return (
    <label className="block">
      <span className="label">{rotulo}</span>
      <textarea className="input" rows={2} value={valor} onChange={(e) => onChange(e.target.value)} placeholder={dica} />
    </label>
  );
}
