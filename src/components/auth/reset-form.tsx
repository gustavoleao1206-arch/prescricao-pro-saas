"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function ResetForm({ token, mode = "reset" }: { token?: string; mode?: "reset" | "create" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  /**
   * Sucesso que NÃO leva ao login.
   *
   * A senha foi definida, mas o acesso da conta está suspenso: mandar a pessoa para a tela de entrada
   * a faria bater numa recusa genérica sem ligação nenhuma com o que ela acabou de fazer. Aqui ela lê
   * o motivo no mesmo lugar onde agiu.
   */
  const [aviso, setAviso] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const title = mode === "create" ? "Criar sua senha" : "Redefinir senha";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password"));
    const confirm = String(f.get("confirm"));
    if (password !== confirm) {
      setError("As senhas não coincidem.");
      return;
    }
    const body: { token?: string; password: string; acceptTerms?: boolean } = { token, password };
    if (mode === "create") {
      if (f.get("acceptTerms") !== "on") {
        setError("É necessário aceitar os termos e as condições da assinatura.");
        return;
      }
      body.acceptTerms = true;
    }
    setLoading(true);
    const res = await fetch("/api/auth/redefinir-senha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setLoading(false);
    if (res.ok && data.ok) {
      if (data.data?.acessoSuspenso) {
        setAviso(data.data.message ?? "Senha definida, mas o acesso desta conta está suspenso.");
        return;
      }
      router.push("/login?definida=1");
    } else {
      setError(data.error ?? "Não foi possível definir a senha.");
    }
  }

  if (!token) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl">Link inválido</h1>
        <p className="mt-3 text-sm text-neutro-600">O link está incompleto ou expirou. Solicite um novo.</p>
        <Link href="/recuperar-senha" className="btn-primary mt-6 inline-flex">Solicitar novo link</Link>
      </div>
    );
  }

  return (
    <div className="card p-8">
      <h1 className="text-2xl">{title}</h1>
      <p className="mt-1 text-sm text-neutro-500">Escolha uma senha forte para sua conta.</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="password">Nova senha</label>
          <input id="password" name="password" type="password" required minLength={10} className="input" />
        </div>
        <div>
          <label className="label" htmlFor="confirm">Confirmar senha</label>
          <input id="confirm" name="confirm" type="password" required minLength={10} className="input" />
        </div>
        {mode === "create" && (
          <label className="flex items-start gap-2 rounded-xl bg-neutro-50 p-3 text-sm">
            <input type="checkbox" name="acceptTerms" className="mt-1" required />
            <span>Li e aceito os <Link href="/termos" className="text-marinho-600 underline">Termos de Uso</Link>, a <Link href="/privacidade" className="text-marinho-600 underline">Política de Privacidade</Link> e as condições da assinatura mensal.</span>
          </label>
        )}
        {error && <p className="rounded-lg bg-alerta-50 px-3 py-2 text-sm text-alerta-700">{error}</p>}
        {aviso && (
          <p className="rounded-lg border border-atencao-100 bg-atencao-50 px-3 py-2 text-sm text-atencao dark:border-atencao/40 dark:bg-atencao/10">
            {aviso}
          </p>
        )}
        <button type="submit" disabled={loading} className="btn-primary w-full">{loading ? "Salvando…" : "Salvar senha"}</button>
      </form>
    </div>
  );
}
