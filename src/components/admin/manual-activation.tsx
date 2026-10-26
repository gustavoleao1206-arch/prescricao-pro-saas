"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Formulário de liberação manual de acesso.
 *
 * Resolve o caso "cliente pagou e o sistema não entregou": venda por PIX,
 * transferência, boleto, contrato empresarial, plano sob consulta — ou webhook
 * do provedor que falhou. Antes disso, liberar acesso exigia inserir linhas à
 * mão no banco de produção.
 */

export interface PlanoOpcao {
  slug: string;
  nome: string;
  periodo: string;
  precoCents: number;
  creditos: number;
}

const METODOS = [
  { valor: "pix", rotulo: "PIX" },
  { valor: "transferencia", rotulo: "Transferência" },
  { valor: "boleto", rotulo: "Boleto" },
  { valor: "cartao", rotulo: "Cartão (fora do sistema)" },
  { valor: "contrato", rotulo: "Contrato / faturado" },
  { valor: "cortesia", rotulo: "Cortesia / teste" },
];

export function ManualActivation({ planos }: { planos: PlanoOpcao[] }) {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [nome, setNome] = useState("");
  const [planoSlug, setPlanoSlug] = useState(planos[0]?.slug ?? "");
  const [valor, setValor] = useState("");
  const [metodo, setMetodo] = useState("pix");
  const [motivo, setMotivo] = useState("");
  const [enviarConvite, setEnviarConvite] = useState(true);

  const plano = planos.find((p) => p.slug === planoSlug);

  function limpar() {
    setEmail("");
    setNome("");
    setValor("");
    setMotivo("");
    setMetodo("pix");
    setEnviarConvite(true);
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    setSucesso(null);
    try {
      const corpo: Record<string, unknown> = {
        email: email.trim(),
        planoSlug,
        metodo,
        motivo: motivo.trim(),
        enviarConvite,
      };
      if (nome.trim()) corpo.nome = nome.trim();
      // Campo em reais, aceitando vírgula como no teclado brasileiro.
      if (valor.trim()) {
        const n = Number(valor.replace(/\./g, "").replace(",", "."));
        if (Number.isNaN(n)) throw new Error("Valor recebido inválido. Use apenas números, ex.: 119,90");
        corpo.valorReais = n;
      }

      const res = await fetch("/api/admin/assinaturas/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? "Não foi possível liberar o acesso.");

      const d = json.data;
      const partes = [
        d.usuarioCriado ? "Conta criada" : "Conta existente reaproveitada",
        `${d.creditosLiberados} crédito(s) liberado(s)`,
        d.usuarioCriado
          ? d.conviteEnviado
            ? "convite de senha enviado"
            : "convite NÃO enviado (veja o aviso abaixo)"
          : "cliente entra com a senha que já possui",
      ];
      setSucesso(`Acesso liberado. ${partes.join(" · ")}.`);
      /**
       * ⚠️ Dois avisos possíveis, e o de cobrança dupla vem PRIMEIRO.
       *
       * O convite que não saiu é chato e se resolve reenviando. A cobrança automática que
       * segue viva cobra o cliente de novo no mês que vem, e a decisão é de quem está
       * nesta tela agora — só essa pessoa sabe se a liberação substitui a cobrança do
       * provedor ou apenas cobre uma falha dele. Some os dois quando houver os dois: o
       * formulário é limpo em seguida, e um aviso perdido aqui não volta.
       */
      const avisos = [d.avisoCobrancaAutomatica, d.avisoConvite ? `O e-mail de convite falhou: ${d.avisoConvite}` : null]
        .filter(Boolean)
        .join(" ");
      if (avisos) setErro(`O acesso está ativo. ${avisos}`);
      limpar();
      router.refresh();
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setEnviando(false);
    }
  }

  if (!aberto) {
    return (
      <button type="button" onClick={() => setAberto(true)} className="btn-primary text-sm">
        Liberar acesso manualmente
      </button>
    );
  }

  return (
    <form onSubmit={enviar} className="card w-full space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-marinho-700 dark:text-neutro-100">Liberar acesso manualmente</h2>
          <p className="mt-1 text-sm text-neutro-500">
            Para venda que não passou pelo checkout (PIX, transferência, boleto, contrato) ou para consertar
            acesso quando o pagamento foi confirmado mas o sistema não liberou.
          </p>
        </div>
        <button type="button" onClick={() => setAberto(false)} className="text-sm text-neutro-500 hover:underline">
          Fechar
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-marinho-700 dark:text-neutro-100">E-mail do cliente *</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="cliente@escritorio.com.br"
            className="input w-full"
          />
          <span className="mt-1 block text-xs text-neutro-400">
            Se já existir conta com este e-mail, ela é reaproveitada (sem duplicar cliente).
          </span>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-marinho-700 dark:text-neutro-100">Nome do cliente</span>
          <input
            type="text"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="Dr. João da Silva"
            className="input w-full"
          />
          <span className="mt-1 block text-xs text-neutro-400">Obrigatório só se a conta ainda não existir.</span>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-marinho-700 dark:text-neutro-100">Plano *</span>
          <select value={planoSlug} onChange={(e) => setPlanoSlug(e.target.value)} className="input w-full" required>
            {planos.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.nome} · {p.periodo === "ANUAL" ? "anual" : "mensal"} · {p.creditos} créditos/mês
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-marinho-700 dark:text-neutro-100">Valor recebido (R$)</span>
          <input
            type="text"
            inputMode="decimal"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            placeholder={plano ? (plano.precoCents / 100).toFixed(2).replace(".", ",") : "0,00"}
            className="input w-full"
          />
          <span className="mt-1 block text-xs text-neutro-400">
            Em branco usa o preço do plano. Informe se cobrou valor diferente (desconto, proporcional).
          </span>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-marinho-700 dark:text-neutro-100">Forma de pagamento</span>
          <select value={metodo} onChange={(e) => setMetodo(e.target.value)} className="input w-full">
            {METODOS.map((m) => (
              <option key={m.valor} value={m.valor}>
                {m.rotulo}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-marinho-700 dark:text-neutro-100">Motivo *</span>
          <input
            type="text"
            required
            minLength={3}
            maxLength={300}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Pago por PIX em 30/07, comprovante no WhatsApp"
            className="input w-full"
          />
          <span className="mt-1 block text-xs text-neutro-400">Fica registrado na auditoria, junto com quem liberou.</span>
        </label>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={enviarConvite}
          onChange={(e) => setEnviarConvite(e.target.checked)}
          className="mt-1"
        />
        <span className="text-neutro-600 dark:text-neutro-300">
          Enviar e-mail com link para o cliente criar a senha (só se a conta for nova)
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={enviando} className="btn-primary disabled:opacity-50">
          {enviando ? "Liberando…" : "Liberar acesso"}
        </button>
        {plano && (
          <span className="text-xs text-neutro-500">
            Vai ativar <strong>{plano.nome}</strong> e liberar <strong>{plano.creditos}</strong> crédito(s) no ciclo atual.
          </span>
        )}
      </div>

      {sucesso && (
        <p className="rounded-xl border border-sucesso-100 bg-sucesso-50 p-3 text-sm font-medium text-sucesso">
          {sucesso}
        </p>
      )}
      {erro && (
        <p className="rounded-xl border border-atencao-100 bg-atencao-50 p-3 text-sm text-atencao dark:border-atencao/40 dark:bg-atencao/10">
          {erro}
        </p>
      )}
    </form>
  );
}
