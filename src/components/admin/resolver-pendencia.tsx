"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Destino = "devolvido" | "aplicado" | "duplicado";

/**
 * Encerra o caso de uma quantia que entrou sem destino.
 *
 * A tela de pendências existe para ser ESVAZIADA. Sem uma saída aqui, a única que
 * havia era devolver no painel do Asaas — e o desfecho mais comum (identificar o
 * pagador e liberar o acesso à mão) não gera evento nenhum, então a linha ficaria
 * para sempre. Lista que só cresce deixa de ser lida.
 */
export function ResolverPendencia({ id, valor }: { id: string; valor: string }) {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [destino, setDestino] = useState<Destino>("devolvido");
  const [motivo, setMotivo] = useState("");
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function enviar() {
    setErro(null);
    if (motivo.trim().length < 5) {
      setErro("Descreva o que foi feito com a quantia.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/pagamentos/${id}/resolver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destino, motivo }),
      });
      const data = await res.json();
      if (res.ok) {
        setAberto(false);
        setMotivo("");
        router.refresh();
      } else {
        setErro(data.error ?? "Não foi possível encerrar o caso.");
      }
    } catch {
      setErro("Falha de conexão.");
    } finally {
      setBusy(false);
    }
  }

  if (!aberto) {
    return (
      <button onClick={() => setAberto(true)} className="text-xs font-medium text-marca-600 hover:underline">
        Encerrar caso
      </button>
    );
  }

  return (
    <div className="w-72 space-y-2 rounded-xl border border-neutro-200 bg-neutro-50 p-3">
      <p className="text-xs text-neutro-500">
        O que aconteceu com os <strong>{valor}</strong>?
      </p>
      <select
        value={destino}
        onChange={(e) => setDestino(e.target.value as Destino)}
        className="w-full rounded-lg border border-neutro-300 bg-white px-2 py-1.5 text-xs text-marinho-700"
      >
        <option value="devolvido">Devolvi ao pagador</option>
        <option value="aplicado">Identifiquei o pagador e liberei o acesso</option>
        <option value="duplicado">Já registrei em outro lançamento</option>
      </select>
      <input
        type="text"
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        className="w-full rounded-lg border border-neutro-300 bg-white px-2 py-1.5 text-xs"
        placeholder="Quem recebeu / o que foi feito (obrigatório)"
      />
      <div className="flex gap-2">
        <button disabled={busy} onClick={enviar} className="btn-primary flex-1 justify-center py-1.5 text-xs">
          {busy ? "Encerrando…" : "Encerrar"}
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setAberto(false);
            setErro(null);
          }}
          className="text-xs text-neutro-500 hover:underline"
        >
          Cancelar
        </button>
      </div>
      {erro && <p className="text-xs text-alerta-700">{erro}</p>}
    </div>
  );
}
