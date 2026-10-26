"use client";

import { useState } from "react";
import Link from "next/link";
import { PLANOS, precoBR } from "@/lib/planos";

export function RegisterForm({ plano }: { plano?: string }) {
  // Mostra o nome comercial do plano, não o slug técnico ("essencial-mensal").
  const planoEscolhido = plano ? PLANOS.find((p) => p.slug === plano) : undefined;
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const body = {
      name: f.get("name"),
      email: f.get("email"),
      phone: f.get("phone") || undefined,
      organizationName: f.get("organizationName") || undefined,
      document: f.get("document") || undefined,
      password: f.get("password"),
      acceptTerms: f.get("acceptTerms") === "on",
      acceptPrivacy: f.get("acceptPrivacy") === "on",
      acceptAi: f.get("acceptAi") === "on",
      acceptSubscription: f.get("acceptSubscription") === "on",
    };
    const res = await fetch("/api/auth/cadastro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setLoading(false);
    if (res.ok && data.ok) setDone(true);
    else setError(data.error ?? "Não foi possível concluir o cadastro.");
  }

  if (done) {
    /**
     * O plano escolhido tem de sobreviver ao cadastro.
     *
     * Antes, o `?plano=` só servia para escrever um rótulo nesta tela e era
     * descartado: depois de confirmar o e-mail e entrar, a pessoa era despejada no
     * painel sem nenhuma lembrança do que havia escolhido, e tinha de descobrir
     * sozinha onde pagar. Levando o destino no `next`, o login devolve ela
     * direto para a contratação do plano em que clicou.
     */
    const destino = plano
      ? `/login?next=${encodeURIComponent(`/assinatura/contratar?plano=${plano}`)}`
      : "/login";
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl">Confirme seu e-mail</h1>
        {/**
         * ⚠️ NÃO diz mais "após confirmar, você poderá entrar" — isso era falso, e falso do pior jeito.
         *
         * Conta pendente de verificação NÃO é impedida de entrar (`PENDENTE_VERIFICACAO` não barra o
         * login). E é por DENTRO que ficam as duas saídas de quem não recebeu o e-mail: o botão de
         * reenviar e a troca do endereço, ambos na área logada. A frase antiga trancava a pessoa fora
         * de onde estava o conserto — quem não recebeu o link concluía que só podia esperar.
         *
         * Confirmar é obrigatório para CONTRATAR, não para entrar, e é isso que o texto diz agora.
         */}
        <p className="mt-3 text-sm text-neutro-600">
          Enviamos um link de confirmação para o seu e-mail. Confirme para poder
          {planoEscolhido ? ` pagar o plano ${planoEscolhido.name}` : " contratar um plano"} — e confira
          a caixa de spam.
        </p>
        <p className="mt-2 text-sm text-neutro-600">
          Você já pode entrar mesmo antes de confirmar. Se o e-mail não chegar, entre e use o aviso no
          topo da tela para reenviar o link ou corrigir o endereço.
        </p>
        <Link href={destino} className="btn-primary mt-6 inline-flex">
          Ir para o login
        </Link>
      </div>
    );
  }

  return (
    <div className="card p-8">
      <h1 className="text-2xl">Criar conta</h1>
      <p className="mt-1 text-sm text-neutro-500">
        {planoEscolhido
          ? `Plano ${planoEscolhido.name} — ${precoBR(planoEscolhido.priceCents)}${planoEscolhido.period === "ANUAL" ? "/ano" : "/mês"}. Confirme o e-mail para seguir ao pagamento.`
          : "Preencha seus dados."}
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="name">Nome completo</label>
          <input id="name" name="name" required className="input" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="email">E-mail</label>
            <input id="email" name="email" type="email" required className="input" />
          </div>
          <div>
            <label className="label" htmlFor="phone">Telefone</label>
            <input id="phone" name="phone" className="input" />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="organizationName">Escritório/Empresa</label>
            <input id="organizationName" name="organizationName" className="input" />
          </div>
          <div>
            <label className="label" htmlFor="document">CPF/CNPJ</label>
            <input id="document" name="document" className="input" />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="password">Senha</label>
          <input id="password" name="password" type="password" required className="input" minLength={10} />
          <p className="mt-1 text-xs text-neutro-400">Mín. 10 caracteres, com maiúscula, minúscula, número e símbolo.</p>
        </div>
        <div className="space-y-2 rounded-xl bg-neutro-50 p-3 text-sm">
          <label className="flex items-start gap-2"><input type="checkbox" name="acceptTerms" className="mt-1" required /> <span>Li e aceito os <Link href="/termos" className="text-marinho-600 underline">Termos de Uso</Link>.</span></label>
          <label className="flex items-start gap-2"><input type="checkbox" name="acceptPrivacy" className="mt-1" required /> <span>Li e aceito a <Link href="/privacidade" className="text-marinho-600 underline">Política de Privacidade</Link>.</span></label>
          <label className="flex items-start gap-2"><input type="checkbox" name="acceptAi" className="mt-1" required /> <span>Estou ciente do <Link href="/responsabilidade" className="text-marinho-600 underline">uso de IA como apoio</Link>, sujeito a revisão jurídica.</span></label>
          <label className="flex items-start gap-2"><input type="checkbox" name="acceptSubscription" className="mt-1" required /> <span>Li e aceito as <Link href="/termos" className="text-marinho-600 underline">condições da assinatura</Link>: mensal, recorrente e cancelável na área do cliente.</span></label>
        </div>
        {error && <p className="rounded-lg bg-alerta-50 px-3 py-2 text-sm text-alerta-700">{error}</p>}
        <button type="submit" disabled={loading} className="btn-primary w-full">{loading ? "Criando…" : "Criar conta"}</button>
      </form>
      <p className="mt-6 text-center text-sm text-neutro-500">
        Já tem conta? <Link href="/login" className="font-medium text-marinho-600 hover:underline">Entrar</Link>
      </p>
    </div>
  );
}
