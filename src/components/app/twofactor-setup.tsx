"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Step = "idle" | "setup" | "codes";

export function TwoFactorSetup({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  async function iniciar() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/conta/2fa/iniciar", { method: "POST" });
    const data = await res.json();
    setBusy(false);
    if (res.ok && data.ok) {
      setQr(data.data.qrDataUrl);
      setSecret(data.data.secret);
      setStep("setup");
    } else {
      setError(data.error ?? "Falha ao iniciar o 2FA.");
    }
  }

  async function confirmar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const token = String(new FormData(e.currentTarget).get("token") ?? "");
    const res = await fetch("/api/conta/2fa/confirmar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok && data.ok) {
      setBackupCodes(data.data.backupCodes ?? []);
      setStep("codes");
    } else {
      setError(data.error ?? "Código inválido.");
    }
  }

  async function desativar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const token = String(new FormData(e.currentTarget).get("token") ?? "");
    const res = await fetch("/api/conta/2fa/desativar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok && data.ok) {
      router.refresh();
    } else {
      setError(data.error ?? "Código inválido.");
    }
  }

  // Já ativo, permite desativar.
  if (enabled && step !== "codes") {
    return (
      <div>
        <p className="mb-3 inline-flex items-center gap-2 text-sm"><span className="badge bg-sucesso-100 text-sucesso">2FA ativo</span> Sua conta está protegida por verificação em duas etapas.</p>
        <form onSubmit={desativar} className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label" htmlFor="token">Código para desativar</label>
            <input id="token" name="token" inputMode="numeric" required className="input w-40 tracking-[0.2em]" placeholder="000000" />
          </div>
          <button type="submit" disabled={busy} className="btn-ghost text-alerta-700">Desativar 2FA</button>
        </form>
        {error && <p className="mt-2 text-sm text-alerta-700">{error}</p>}
      </div>
    );
  }

  // Códigos de backup (exibidos uma única vez).
  if (step === "codes") {
    return (
      <div>
        <p className="mb-2 text-sm font-medium text-sucesso">2FA ativado! Guarde os códigos de backup abaixo, pois eles são mostrados apenas uma vez.</p>
        <ul className="grid grid-cols-2 gap-2 rounded-xl bg-neutro-50 p-4 font-mono text-sm">
          {backupCodes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <button onClick={() => { setStep("idle"); router.refresh(); }} className="btn-primary mt-4">Concluir</button>
      </div>
    );
  }

  // Setup, mostra QR e pede confirmação.
  if (step === "setup") {
    return (
      <div>
        <p className="mb-3 text-sm text-neutro-600">Escaneie o QR code no seu app autenticador (Google Authenticator, Authy, etc.) e digite o código gerado.</p>
        {qr && <img src={qr} alt="QR code 2FA" className="mb-3 rounded-lg border border-neutro-200" width={200} height={200} />}
        {secret && <p className="mb-3 text-xs text-neutro-500">Ou insira manualmente: <span className="font-mono">{secret}</span></p>}
        <form onSubmit={confirmar} className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label" htmlFor="token">Código do app</label>
            <input id="token" name="token" inputMode="numeric" autoFocus required className="input w-40 tracking-[0.2em]" placeholder="000000" />
          </div>
          <button type="submit" disabled={busy} className="btn-primary">Confirmar e ativar</button>
          <button type="button" onClick={() => setStep("idle")} className="btn-ghost">Cancelar</button>
        </form>
        {error && <p className="mt-2 text-sm text-alerta-700">{error}</p>}
      </div>
    );
  }

  // Estado inicial (desativado).
  return (
    <div>
      <p className="mb-3 text-sm text-neutro-500">Adicione uma camada extra de segurança exigindo um código do seu celular ao entrar.</p>
      <button onClick={iniciar} disabled={busy} className="btn-outline">{busy ? "…" : "Ativar 2FA"}</button>
      {error && <p className="mt-2 text-sm text-alerta-700">{error}</p>}
    </div>
  );
}
