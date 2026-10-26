"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Conversa de um chamado: histórico, campo de resposta e — para a equipe —
 * botões de status.
 *
 * Usado nos dois lados (cliente e admin) para que a conversa seja literalmente
 * a mesma coisa nas duas telas, sem risco de divergirem.
 */

export interface MensagemChamado {
  id: string;
  body: string;
  createdAt: string;
  autorNome: string;
  daEquipe: boolean;
}

interface Props {
  ticketId: string;
  numero: number;
  status: string;
  mensagens: MensagemChamado[];
  /** true = visão da equipe (mostra os botões de status). */
  equipe?: boolean;
}

const ROTULO_STATUS: Record<string, string> = {
  ABERTO: "Aberto",
  EM_ATENDIMENTO: "Em atendimento",
  AGUARDANDO_CLIENTE: "Aguardando cliente",
  RESOLVIDO: "Resolvido",
  ENCERRADO: "Encerrado",
};

export function SupportThread({ ticketId, numero, status, mensagens, equipe = false }: Props) {
  const router = useRouter();
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  async function responder(e: React.FormEvent) {
    e.preventDefault();
    const corpo = texto.trim();
    if (!corpo) return;
    setEnviando(true);
    setErro(null);
    setAviso(null);
    try {
      const res = await fetch(`/api/suporte/${ticketId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: corpo }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Não foi possível enviar a resposta.");
      setTexto("");
      setAviso(equipe ? "Resposta enviada ao cliente." : "Resposta registrada.");
      router.refresh();
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setEnviando(false);
    }
  }

  async function mudarStatus(novo: string) {
    setEnviando(true);
    setErro(null);
    setAviso(null);
    try {
      const res = await fetch(`/api/admin/suporte/${ticketId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: novo }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Não foi possível mudar o status.");
      setAviso(`Chamado marcado como "${ROTULO_STATUS[novo] ?? novo}".`);
      router.refresh();
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setEnviando(false);
    }
  }

  const fechado = status === "RESOLVIDO" || status === "ENCERRADO";

  return (
    <div className="space-y-4">
      <ol className="space-y-3">
        {mensagens.map((m) => (
          <li
            key={m.id}
            className={`rounded-2xl border p-4 ${
              m.daEquipe
                ? "border-marca-200 bg-marca-50 dark:border-marca-500/30 dark:bg-marca-500/10"
                : "border-neutro-200 bg-white dark:border-neutro-700 dark:bg-neutro-900"
            }`}
          >
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-marinho-700 dark:text-neutro-100">
                {m.autorNome}
                {m.daEquipe && (
                  <span className="ml-2 badge bg-marca-100 text-marca-700 dark:bg-marca-500/20 dark:text-marca-200">
                    Suporte
                  </span>
                )}
              </span>
              <span className="text-xs text-neutro-400">{m.createdAt}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-neutro-700 dark:text-neutro-200">{m.body}</p>
          </li>
        ))}
      </ol>

      {equipe && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-neutro-200 bg-neutro-50 p-3 dark:border-neutro-700 dark:bg-neutro-900/50">
          <span className="text-xs font-semibold uppercase tracking-wide text-neutro-500">Marcar como</span>
          {(["EM_ATENDIMENTO", "RESOLVIDO", "ENCERRADO"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => mudarStatus(s)}
              disabled={enviando || status === s}
              className="rounded-lg border border-neutro-300 bg-white px-2.5 py-1.5 text-xs font-medium text-marinho-700 hover:border-marca-400 disabled:opacity-40 dark:border-neutro-600 dark:bg-neutro-800 dark:text-neutro-100"
            >
              {ROTULO_STATUS[s]}
            </button>
          ))}
          {fechado && (
            <button
              type="button"
              onClick={() => mudarStatus("ABERTO")}
              disabled={enviando}
              className="text-xs font-medium text-atencao hover:underline disabled:opacity-40"
            >
              Reabrir
            </button>
          )}
        </div>
      )}

      <form onSubmit={responder} className="space-y-2">
        <label htmlFor={`resp-${ticketId}`} className="block text-sm font-medium text-marinho-700 dark:text-neutro-100">
          {equipe ? `Responder ao cliente (chamado #${numero})` : "Escrever uma resposta"}
        </label>
        <textarea
          id={`resp-${ticketId}`}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={4}
          maxLength={5000}
          required
          placeholder={equipe ? "Sua resposta será enviada ao cliente por e-mail." : "Descreva o que ainda está pendente."}
          className="input w-full"
        />
        {fechado && !equipe && (
          <p className="text-xs text-neutro-500">
            Este chamado está {ROTULO_STATUS[status]?.toLowerCase()}. Ao responder, ele é reaberto automaticamente.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={enviando || !texto.trim()} className="btn-primary disabled:opacity-50">
            {enviando ? "Enviando…" : "Enviar resposta"}
          </button>
          {aviso && <span className="text-sm font-medium text-sucesso">{aviso}</span>}
        </div>
        {erro && (
          <p className="rounded-xl border border-atencao-100 bg-atencao-50 p-3 text-sm text-atencao dark:border-atencao/40 dark:bg-atencao/10">
            {erro}
          </p>
        )}
      </form>
    </div>
  );
}
