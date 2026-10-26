"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * Aviso de conta pendente de confirmação, com o botão de reenviar.
 *
 * ── Por que precisou existir junto com a rota ─────────────────────────────────
 * A rota de reenvio sem lugar para ser chamada é um botão que não existe. E o problema era
 * maior que a falta do botão: NADA na aplicação dizia que a conta estava pendente. A rota de
 * login devolvia `needsVerification`, e nenhuma tela lia esse campo — informação calculada,
 * transmitida e jogada fora.
 *
 * Então quem se cadastrava e não recebia o e-mail entrava, usava, e só descobria que havia algo
 * pendente se procurasse. Agora o aviso acompanha a pessoa pela área logada até ela confirmar.
 *
 * ── O tom é deliberado ────────────────────────────────────────────────────────
 * Não é erro nem bloqueio: a conta funciona. É pendência, e o texto diz o que ela é, por que
 * importa (recuperar senha e receber avisos de cobrança dependem do endereço estar confirmado) e
 * oferece a saída num clique. Alarme vermelho aqui assustaria sem motivo — e assustar com o que
 * não é grave é como se aprende a ignorar o aviso que é.
 */
export function AvisoVerificarEmail({ email }: { email: string }) {
  const [estado, setEstado] = useState<"parado" | "enviando" | "pronto">("parado");
  const [mensagem, setMensagem] = useState<string | null>(null);

  async function reenviar() {
    setEstado("enviando");
    setMensagem(null);
    try {
      const res = await fetch("/api/auth/reenviar-verificacao", { method: "POST" });
      const dados = await res.json();
      /**
       * A mensagem do servidor é usada como veio, inclusive nas recusas. Ela distingue casos que
       * a tela não tem como distinguir sozinha — já confirmado, limite atingido, envio que
       * falhou — e cada um pede uma ação diferente de quem lê.
       */
      setMensagem(dados?.error ?? dados?.data?.message ?? "Não foi possível reenviar agora.");
      setEstado("pronto");
    } catch {
      setMensagem("Não foi possível reenviar agora. Tente novamente em alguns minutos.");
      setEstado("pronto");
    }
  }

  return (
    <div className="mb-6 rounded-2xl border border-atencao-100 bg-atencao-50 p-4 dark:border-atencao/40 dark:bg-atencao/10">
      <p className="text-sm font-medium text-atencao">Confirme seu e-mail</p>
      <p className="mt-1 text-sm text-atencao">
        Enviamos um link de confirmação para <strong>{email}</strong>. Confirmar mantém a
        recuperação de senha e os avisos de cobrança funcionando.
      </p>
      {/**
       * ⚠️ O CAMINHO DE QUEM ERROU O ENDEREÇO, que faltava aqui.
       *
       * O aviso mostrava o endereço e oferecia só o reenvio — inútil justamente para o caso em que
       * confirmar é impossível: o e-mail está errado, e reenviar manda outro link para a mesma caixa
       * inalcançável. A pessoa clicava três vezes, esgotava o limite e não tinha mais nada a fazer.
       *
       * E este é o beco que barra VENDA: contratar exige e-mail confirmado, e o endereço errado é
       * exatamente o defeito que a recusa da contratação não consegue consertar sozinha.
       */}
      <p className="mt-1 text-sm text-atencao">
        Se esse endereço está errado, não reenvie: troque o e-mail em{" "}
        <Link href="/configuracoes" className="underline">
          Configurações
        </Link>
        , e o link novo vai para o endereço certo.
      </p>
      {/**
       * ⚠️ O BOTÃO NÃO DESAPARECE MAIS DEPOIS DA PRIMEIRA MENSAGEM.
       *
       * A versão anterior trocava o botão pela mensagem — e isso tirava a saída da tela exatamente
       * nos casos em que ela é necessária. "Não conseguimos enviar o e-mail agora. Tente novamente
       * em alguns minutos" ficava sem nada em que tentar novamente; a recusa por limite dizia para
       * esperar e depois não havia botão para voltar a usar; e a falha de rede desarmava a única
       * ação da tela. Só recarregando a página o botão voltava, e ninguém deduz isso.
       *
       * Mensagem e botão convivem. A conta pendente é um estado que dura, não um formulário que se
       * encerra no primeiro envio.
       */}
      {mensagem && (
        <p className="mt-3 rounded-xl bg-atencao-100/60 p-2 text-sm font-medium text-atencao dark:bg-atencao/20">
          {mensagem}
        </p>
      )}
      <button
        type="button"
        onClick={() => void reenviar()}
        disabled={estado === "enviando"}
        className="btn-secondary mt-3 text-sm disabled:opacity-60"
      >
        {estado === "enviando"
          ? "Enviando…"
          : mensagem
            ? /**
               * O rótulo muda depois da primeira tentativa. "Reenviar o e-mail de confirmação" ao
               * lado de "enviamos um novo link" faz a pessoa duvidar se o primeiro clique valeu.
               */
              "Enviar de novo"
            : "Reenviar o e-mail de confirmação"}
      </button>
    </div>
  );
}
