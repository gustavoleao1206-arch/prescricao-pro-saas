"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { temOperacaoLonga } from "@/lib/operacao-em-andamento";

/**
 * Encerra a sessão na TELA quando ninguém mexe há tempo demais.
 *
 * ── Por que existe, se o servidor já encerra ──────────────────────────────────
 * O servidor é quem decide: `usuarioDaSessao` recusa e REVOGA a sessão parada há mais de
 * `SESSION_IDLE_MINUTES`. Essa é a garantia, e ela não depende de nada que aconteça no
 * navegador. Só que sozinha ela deixa dois problemas:
 *
 *  1. A tela continua lá, com os dados na frente de quem passar, até alguém clicar. A
 *     sessão está morta no servidor e a informação segue visível — que é justamente o risco
 *     que o encerramento por inatividade existe para tratar. Autos de execução fiscal e
 *     dados de terceiros sob sigilo profissional não devem ficar expostos porque ninguém
 *     tocou o mouse.
 *  2. Quando a pessoa finalmente clica, ela recebe um erro de autenticação sem explicação,
 *     e a leitura natural disso é "o sistema quebrou".
 *
 * ── O que conta como "mexer", e por que não é tráfego de rede ─────────────────
 * O relógio daqui é movido por INTERAÇÃO REAL: clique, tecla, rolagem, toque. Não por
 * requisição HTTP — e a diferença é concreta neste produto: a tela de análise faz
 * `router.refresh()` a cada 4 segundos enquanto o processamento corre (ver
 * `analysis-actions.tsx`). Se tráfego contasse como uso, deixar uma análise processando
 * manteria a sessão viva sem ninguém na frente, ou seja, o caso exato que a regra quer
 * pegar.
 *
 * Por isso este componente também AVISA o servidor: o ping de atividade é o que mantém
 * `lastSeenAt` andando durante o uso normal. Sem ele, quem lê um relatório longo por meia
 * hora seria desconectado no meio da leitura só porque a leitura não gera navegação.
 */

/** Eventos que provam que há alguém ali. `visibilitychange` não entra: aba ao fundo não é uso. */
const EVENTOS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

/**
 * De quanto em quanto tempo, no máximo, o ping sai. Interação é contínua (rolar dispara
 * dezenas de eventos por segundo); sem esta folga cada rolagem viraria uma requisição.
 */
const INTERVALO_MINIMO_DO_PING_MS = 60_000;

/** Com que frequência o relógio é conferido. Um minuto é resolução suficiente para 30. */
const PASSO_DA_CONFERENCIA_MS = 30_000;

/**
 * Onde a última interação é anotada para as OUTRAS ABAS verem.
 *
 * ── O defeito que isto conserta, e era grave ──────────────────────────────────
 * O relógio era por instância do componente e os eventos são de `window`, que é de UMA aba.
 * Interação numa aba não movia o relógio das outras. Então a aba parada num segundo monitor
 * — o painel administrativo aberto ao lado da análise, uso normal com 10 minutos de prazo —
 * disparava e chamava o logout, que REVOGA o token do cookie. E o cookie é um só para o
 * navegador inteiro: a sessão de quem estava trabalhando na outra aba morria.
 *
 * Pior: o servidor considerava aquela sessão ATIVA (os pings da aba em uso mantinham o
 * relógio andando). Quem encerrava era o relógio da aba parada, o inverso exato de "o
 * servidor é a autoridade".
 *
 * `localStorage` é compartilhado entre as abas da mesma origem, então a conta passa a ser
 * "nenhuma aba viu interação", que é a pergunta certa.
 */
const CHAVE_DA_INTERACAO = "ptp_ultima_interacao";

/** Lê o instante da última interação em QUALQUER aba. Recuo para o relógio local. */
function ultimaInteracaoGlobal(local: number): number {
  try {
    const bruto = window.localStorage.getItem(CHAVE_DA_INTERACAO);
    const lido = bruto ? Number(bruto) : 0;
    // Valor adulterado ou de outra época não pode esticar o prazo: só serve se for coerente.
    if (!Number.isFinite(lido) || lido > Date.now() + 60_000) return local;
    return Math.max(local, lido);
  } catch {
    // Navegação privativa ou armazenamento bloqueado: cai no relógio desta aba.
    return local;
  }
}

export function EncerrarPorInatividade({ minutos }: { minutos: number }) {
  const router = useRouter();
  const ultimaInteracao = useRef(Date.now());
  const ultimoPing = useRef(0);
  const encerrando = useRef(false);

  useEffect(() => {
    /**
     * Zero desliga a regra — o mesmo que no servidor. E valor inutilizável também desliga:
     * com `minutos` vindo NaN, a comparação `decorrido <= NaN` é falsa, o `return` não
     * acontecia e a tela expulsava TODO MUNDO a cada 30 segundos. O servidor já protege a
     * origem desse número, e aqui a guarda é a segunda: componente que recebe dado de fora
     * não confia nele.
     */
    if (!Number.isFinite(minutos) || minutos <= 0) return;
    const limiteMs = minutos * 60_000;

    function marcar() {
      ultimaInteracao.current = Date.now();
      // Anota para as outras abas: sem isto, a aba parada derrubava a aba em uso.
      try {
        window.localStorage.setItem(CHAVE_DA_INTERACAO, String(ultimaInteracao.current));
      } catch {
        // Armazenamento bloqueado não pode impedir o resto de funcionar.
      }
      /**
       * O ping mantém o `lastSeenAt` do servidor andando. É `keepalive` para não ser
       * cancelado se a interação foi um clique que já está trocando de página, e a falha é
       * ignorada de propósito: perder um ping atrasa o relógio do servidor, e o pior caso é
       * um encerramento alguns minutos cedo — nunca um acesso indevido.
       */
      const agora = Date.now();
      if (agora - ultimoPing.current < INTERVALO_MINIMO_DO_PING_MS) return;
      ultimoPing.current = agora;
      void fetch("/api/auth/atividade", { method: "POST", keepalive: true }).catch(() => {});
    }

    for (const evento of EVENTOS) {
      window.addEventListener(evento, marcar, { passive: true });
    }

    const relogio = setInterval(() => {
      if (encerrando.current) return;

      /**
       * ⚠️ Envio em andamento NÃO é inatividade — e cortá-lo destruía o trabalho.
       *
       * Subir um documento não gera clique, tecla nem rolagem: a pessoa escolhe o arquivo,
       * manda, e espera. Um PDF de execução fiscal com centenas de páginas em conexão comum
       * leva minutos, e passando do prazo esta tela navegava para o login NO MEIO DO ENVIO —
       * a requisição em voo era abortada pela navegação e o documento se perdia. Com 10
       * minutos de prazo para a equipe, isso é uso normal.
       *
       * `marcar()` em vez de só adiar: além de não encerrar aqui, o relógio do SERVIDOR
       * precisa continuar andando durante o envio, senão a sessão morreria no servidor e o
       * passo seguinte ao envio falharia com "não autenticado". E marcar aqui é também o que
       * dá folga depois que o envio termina — encerrar no instante em que o arquivo acabou de
       * subir seria o pior momento possível.
       *
       * O critério é estreito de propósito: vale para o que o NAVEGADOR está executando com
       * os dados da pessoa, não para espera passiva por trabalho do servidor. Ver
       * `operacao-em-andamento.ts`.
       */
      if (temOperacaoLonga()) {
        marcar();
        return;
      }

      // A conta é sobre TODAS as abas, não só esta. Ver `ultimaInteracaoGlobal`.
      if (Date.now() - ultimaInteracaoGlobal(ultimaInteracao.current) <= limiteMs) return;

      encerrando.current = true;
      /**
       * ⚠️ NÃO chama o logout. Esta linha era `await fetch("/api/auth/logout")`, e era o
       * defeito mais sério de todo o desenho.
       *
       * `destroySession` revoga o token do COOKIE, e o cookie é um só para o navegador
       * inteiro. Uma aba parada — o painel aberto no segundo monitor — matava a sessão de
       * quem estava trabalhando na outra aba, e o servidor considerava aquela sessão ativa.
       * O relógio de uma aba não pode ter poder destrutivo sobre a sessão inteira.
       *
       * E não precisa ter: o servidor já recusa e revoga a sessão parada na primeira
       * requisição que a toque (`usuarioDaSessao`). O trabalho desta tela é outro, e é só
       * este — parar de mostrar os dados e levar a pessoa ao login. Se o julgamento local
       * estiver errado porque outra aba está em uso, o pior que acontece agora é esta aba ir
       * para o login e voltar, em vez de derrubar o trabalho de alguém.
       */
      // `replace` para o botão "voltar" não recolocar a tela com os dados na frente.
      router.replace("/login?motivo=inatividade");
    }, PASSO_DA_CONFERENCIA_MS);

    return () => {
      for (const evento of EVENTOS) window.removeEventListener(evento, marcar);
      clearInterval(relogio);
    };
  }, [minutos, router]);

  return null;
}
