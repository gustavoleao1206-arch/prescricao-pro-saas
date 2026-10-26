"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Ações sobre um usuário na listagem do admin.
 *
 * Duas proteções vieram de um risco real: bloquear era um clique único e sem
 * aviso, e nada impedia o administrador de bloquear a PRÓPRIA conta — o que
 * revoga as sessões dele na hora e, sendo ele o único ADMIN, deixa o sistema sem
 * administrador. Aqui: confirmação antes de bloquear, e a ação nem aparece na
 * própria linha. A garantia de verdade está no servidor
 * (src/app/api/admin/usuarios/[id]/route.ts) — isto é conveniência.
 */
interface Inventario {
  email: string;
  nome: string;
  organizacoes: { id: string; nome: string }[];
  assinaturas: { id: string; status: string }[];
  pagamentos: number;
  pagamentosAprovados: number;
  lancamentosDeCredito: number;
  analises: number;
  documentos: number;
  auditoriaPreservada: number;
}

export function UserActions({
  id,
  status,
  email,
  ehVoceMesmo = false,
}: {
  id: string;
  status: string;
  email?: string;
  ehVoceMesmo?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [editandoEmail, setEditandoEmail] = useState(false);
  const [novoEmail, setNovoEmail] = useState(email ?? "");
  const [aviso, setAviso] = useState<string | null>(null);

  // Exclusão: passa por um painel que mostra o que será destruído e exige que o
  // e-mail seja digitado. Ver `abrirExclusao`.
  const [apagando, setApagando] = useState(false);
  const [inventario, setInventario] = useState<Inventario | null>(null);
  const [emailDigitado, setEmailDigitado] = useState("");
  const [forcar, setForcar] = useState(false);

  /**
   * Correção de e-mail. Existe porque e-mail digitado errado no checkout era
   * irreversível pela interface: o link de criação de senha e o "esqueci minha
   * senha" iam para o endereço errado, e o cliente pagante nunca conseguia
   * entrar — sem ninguém poder corrigir uma letra.
   */
  async function salvarEmail(e: React.FormEvent) {
    e.preventDefault();
    const valor = novoEmail.trim().toLowerCase();
    if (!valor || valor === (email ?? "").toLowerCase()) {
      setEditandoEmail(false);
      return;
    }
    if (!window.confirm(`Alterar o e-mail de acesso para "${valor}"? O cliente passará a entrar com este endereço.`)) {
      return;
    }
    setBusy(true);
    setErro(null);
    setAviso(null);
    try {
      const res = await fetch(`/api/admin/usuarios/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: valor }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? "Não foi possível alterar o e-mail.");
      setAviso("E-mail alterado.");
      setEditandoEmail(false);
      router.refresh();
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(newStatus: string) {
    if (newStatus !== "ATIVO") {
      const ok = window.confirm(
        "Bloquear este usuário encerra as sessões dele imediatamente e impede o acesso. Confirmar?",
      );
      if (!ok) return;
    }
    setBusy(true);
    setErro(null);
    try {
      const res = await fetch(`/api/admin/usuarios/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error ?? "Não foi possível alterar o usuário.");
      }
      router.refresh();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Abre o painel de exclusão já com o inventário do que será destruído.
   *
   * Buscar antes de confirmar é o ponto: "apagar conta" não tem desfazer, e
   * confirmar sem saber que junto vão as análises e o histórico de pagamento é
   * decidir no escuro.
   */
  async function abrirExclusao() {
    setErro(null);
    setAviso(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/usuarios/${id}`);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? "Não foi possível ler os dados da conta.");
      setInventario(json.data.inventario as Inventario);
      setEmailDigitado("");
      setForcar(false);
      setApagando(true);
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmarExclusao(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErro(null);
    try {
      const res = await fetch(`/api/admin/usuarios/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailConfirmacao: emailDigitado.trim(), forcar }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? "Não foi possível apagar a conta.");
      setApagando(false);
      router.refresh();
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (ehVoceMesmo) {
    return <span className="text-xs text-neutro-400">Sua conta</span>;
  }

  if (apagando && inventario) {
    const temPagamentoAprovado = inventario.pagamentosAprovados > 0;
    return (
      <form onSubmit={confirmarExclusao} className="w-72 rounded-xl border border-alerta-100 bg-alerta-50 p-3">
        <p className="text-xs font-semibold text-alerta-700">Apagar definitivamente esta conta</p>

        <ul className="mt-2 space-y-0.5 text-xs text-neutro-600">
          <li>{inventario.organizacoes.length} organização(ões)</li>
          <li>
            {inventario.assinaturas.length} assinatura(s)
            {inventario.assinaturas.length > 0 ? ` — ${inventario.assinaturas.map((s) => s.status).join(", ")}` : ""}
          </li>
          <li>
            {inventario.pagamentos} pagamento(s)
            {temPagamentoAprovado ? ` — ${inventario.pagamentosAprovados} APROVADO(S)` : ""}
          </li>
          <li>{inventario.analises} análise(s) e {inventario.documentos} documento(s)</li>
          <li>{inventario.lancamentosDeCredito} lançamento(s) de crédito</li>
        </ul>
        <p className="mt-2 text-xs text-neutro-500">
          Não tem desfazer. Os {inventario.auditoriaPreservada} registro(s) de auditoria são preservados sem o
          vínculo à pessoa.
        </p>

        {temPagamentoAprovado && (
          <label className="mt-2 flex items-start gap-2 rounded-lg bg-atencao-50 p-2 text-xs text-atencao">
            <input type="checkbox" checked={forcar} onChange={(e) => setForcar(e.target.checked)} className="mt-0.5" />
            <span>
              Esta conta <strong>pagou</strong>. Apagar destrói o histórico da venda, que precisa ser guardado.
              Confirmo que é cobrança de teste.
            </span>
          </label>
        )}

        <label className="mt-2 block text-xs text-neutro-600">
          Digite <strong>{inventario.email}</strong> para confirmar:
        </label>
        <input
          type="text"
          required
          autoFocus
          autoComplete="off"
          value={emailDigitado}
          onChange={(e) => setEmailDigitado(e.target.value)}
          className="input mt-1 w-full py-1 text-xs"
          placeholder={inventario.email}
        />

        <div className="mt-2 flex gap-2">
          <button
            type="submit"
            disabled={busy || emailDigitado.trim().toLowerCase() !== inventario.email.toLowerCase() || (temPagamentoAprovado && !forcar)}
            className="text-xs font-semibold text-alerta-700 hover:underline disabled:opacity-40"
          >
            {busy ? "Apagando…" : "Apagar para sempre"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setApagando(false);
              setErro(null);
            }}
            className="text-xs text-neutro-500 hover:underline disabled:opacity-40"
          >
            Cancelar
          </button>
        </div>
        {erro && <span className="mt-1 block text-xs text-alerta-700">{erro}</span>}
      </form>
    );
  }

  if (editandoEmail) {
    return (
      <form onSubmit={salvarEmail} className="flex flex-col gap-1">
        <input
          type="email"
          required
          autoFocus
          value={novoEmail}
          onChange={(e) => setNovoEmail(e.target.value)}
          className="input w-56 py-1 text-xs"
          placeholder="cliente@escritorio.com.br"
        />
        <div className="flex gap-2">
          <button disabled={busy} type="submit" className="text-xs font-medium text-marca-700 hover:underline disabled:opacity-40">
            {busy ? "Salvando…" : "Salvar"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setNovoEmail(email ?? "");
              setEditandoEmail(false);
              setErro(null);
            }}
            className="text-xs text-neutro-500 hover:underline disabled:opacity-40"
          >
            Cancelar
          </button>
        </div>
        {erro && <span className="text-xs text-atencao">{erro}</span>}
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {status !== "ATIVO" ? (
          <button
            disabled={busy}
            onClick={() => setStatus("ATIVO")}
            className="text-xs font-medium text-sucesso hover:underline disabled:opacity-40"
          >
            Ativar
          </button>
        ) : (
          <button
            disabled={busy}
            onClick={() => setStatus("BLOQUEADO")}
            className="text-xs font-medium text-alerta-700 hover:underline disabled:opacity-40"
          >
            Bloquear
          </button>
        )}
        {email && (
          <button
            disabled={busy}
            onClick={() => {
              setErro(null);
              setAviso(null);
              setEditandoEmail(true);
            }}
            className="text-xs font-medium text-neutro-500 hover:underline disabled:opacity-40"
          >
            Corrigir e-mail
          </button>
        )}
        <button
          disabled={busy}
          onClick={abrirExclusao}
          className="text-xs font-medium text-alerta-700 hover:underline disabled:opacity-40"
        >
          Apagar
        </button>
      </div>
      {aviso && <span className="text-xs text-sucesso">{aviso}</span>}
      {erro && <span className="text-xs text-atencao">{erro}</span>}
    </div>
  );
}
