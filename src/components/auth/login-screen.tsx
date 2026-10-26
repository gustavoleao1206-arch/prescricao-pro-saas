"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * Formulário de login da página principal (tema escuro).
 * Apresenta apenas: login/e-mail, senha (com mostrar/ocultar) e botão ENTRAR.
 * Mensagens genéricas para não expor a existência de contas.
 */
export function LoginScreen({ next }: { next?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [needs2fa, setNeeds2fa] = useState(false);
  const [creds, setCreds] = useState<{ email: string; password: string }>({ email: "", password: "" });

  async function submit(email: string, password: string, totp?: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, totp }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        const dest = next ?? data.data?.redirect ?? "/painel";
        router.push(dest);
        router.refresh();
        return;
      }
      if (data.require2fa) {
        setCreds({ email, password });
        setNeeds2fa(true);
        setError(totp ? "Código inválido. Tente novamente." : null);
        return;
      }
      // Mensagens conforme especificação (genéricas / suporte).
      setError(data.error ?? "Login ou senha inválidos.");
    } catch {
      setError("Falha de conexão. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return; // bloqueia múltiplos cliques
    const f = new FormData(e.currentTarget);
    if (needs2fa) {
      await submit(creds.email, creds.password, String(f.get("totp") ?? ""));
    } else {
      await submit(String(f.get("email") ?? "").trim(), String(f.get("password") ?? ""));
    }
  }

  const inputCls =
    "w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-base text-white placeholder-white/40 outline-none transition focus:border-marca-400 focus:ring-2 focus:ring-marca-400/30";

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {!needs2fa ? (
        <>
          <div>
            <label htmlFor="email" className="sr-only">Login ou e-mail</label>
            <input
              id="email"
              name="email"
              type="text"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              placeholder="Digite seu login ou e-mail"
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="password" className="sr-only">Senha</label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPw ? "text" : "password"}
                autoComplete="current-password"
                required
                placeholder="Digite sua senha"
                className={`${inputCls} pr-12`}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? "Ocultar senha" : "Mostrar senha"}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-white/50 transition hover:text-white/80"
              >
                {showPw ? <EyeOff /> : <Eye />}
              </button>
            </div>
          </div>
        </>
      ) : (
        <div>
          <label htmlFor="totp" className="sr-only">Código de verificação</label>
          <input
            id="totp"
            name="totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            placeholder="Código de verificação"
            className={`${inputCls} tracking-[0.3em]`}
          />
        </div>
      )}

      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        // Desabilitado dessatura o gradiente em vez de reduzir a opacidade:
        // esmaecer mistura o rótulo escuro com o fundo e o texto some.
        className="grad-marca w-full rounded-xl px-4 py-3 text-sm font-semibold uppercase tracking-wider text-[#04122E] shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:saturate-50"
      >
        {loading ? "Entrando…" : needs2fa ? "Confirmar código" : "Entrar"}
      </button>

      {!needs2fa && (
        <p className="pt-1 text-center">
          <Link href="/recuperar-senha" className="text-xs text-white/45 transition hover:text-white/75">
            Esqueci minha senha
          </Link>
        </p>
      )}

      {needs2fa && (
        <button
          type="button"
          onClick={() => { setNeeds2fa(false); setError(null); }}
          className="w-full text-center text-xs text-white/50 transition hover:text-white/80"
        >
          Voltar
        </button>
      )}
    </form>
  );
}

function Eye() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-6.5 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22" />
      <path d="M9.53 9.53a3 3 0 0 0 4.24 4.24" />
    </svg>
  );
}
