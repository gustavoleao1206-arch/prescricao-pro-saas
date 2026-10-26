"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * ⚠️ Importa de `analise-execucao`, NÃO de `analise-travada`.
 *
 * Este arquivo roda no navegador. `analise-travada` importa o cliente do banco e as variáveis de
 * ambiente, e o empacotador levava tudo para o pacote público — confirmado no build de produção.
 * `analise-execucao` é um módulo puro, só com constantes. Ver o cabeçalho dele.
 */
import { STATUS_EM_EXECUCAO } from "@/lib/analise-execucao";

/**
 * `temPeticao` esconde os downloads da peça quando ela não existe, é o caso do
 * resultado negativo ou inconclusivo, em que a especificação proíbe oferecer
 * petição. Botão que baixaria um arquivo inexistente é botão sem função.
 */
export function AnalysisActions({
  id,
  status,
  temPeticao = true,
  interrompido = false,
  papel = "CLIENTE",
  acoes = { cancelar: false, arquivar: false, desarquivar: false },
  creditoAPerder = 0,
}: {
  id: string;
  status: string;
  temPeticao?: boolean;
  /** Execução sem sinal de vida: não há mais o que esperar. */
  interrompido?: boolean;
  /**
   * Papel de quem está olhando. Governa DE QUEM é o crédito: a equipe interna reprocessa
   * sem debitar o cliente, e cobrar em nome dele é um segundo botão, explícito.
   */
  papel?: string;
  /**
   * Quais ações de situação cabem nesta análise agora — decidido NO SERVIDOR.
   *
   * ⚠️ Não é o cliente que decide. A regra vive em `src/lib/situacao-da-analise.ts` e é a mesma que a
   * rota aplica; recalculá-la aqui criaria duas versões dela, e o sintoma seria o pior: botão visível
   * que o servidor recusa, ou saída escondida de quem está justamente tentando se resolver. Passar
   * booleanos prontos também evita arrastar o módulo do servidor para o pacote do navegador.
   */
  acoes?: { cancelar: boolean; arquivar: boolean; desarquivar: boolean };
  /**
   * Quanto crédito voltaria ao saldo se a análise fosse CANCELADA — e portanto quanto se perde ao
   * EXCLUIR. Vem do servidor, pela mesma conta do estorno: um número aqui que não seja exatamente o
   * que o estorno devolveria é pior que nenhum número.
   */
  creditoAPerder?: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /** Situação encerrada: reprocessar aqui ressuscitaria a análise e cobraria o crédito de novo. */
  const encerrada = status === "CANCELADA" || status === "ARQUIVADA";

  /**
   * Poll de status enquanto estiver processando — e SÓ enquanto houver o que esperar.
   *
   * Execução abandonada mantém o status de processamento para sempre, então o poll
   * recarregava a página a cada quatro segundos indefinidamente, atrás de uma mudança
   * que nunca vem.
   */
  useEffect(() => {
    if (interrompido || !STATUS_EM_EXECUCAO.includes(status as never)) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [status, interrompido, router]);

  /**
   * Reprocessar é gratuito — MENOS quando os documentos mudaram de faixa.
   *
   * Reexecutar o mesmo material não cobra de novo, e é assim que o produto promete. Mas
   * documentos acrescentados podem levar o processo para uma faixa mais cara, e aí a
   * DIFERENÇA é debitada (ver `consumirCreditos`). Este botão disparava direto: o
   * cliente clicaria em "Reprocessar" esperando o gratuito e veria créditos saírem.
   *
   * Por isso o custo é consultado ANTES e, havendo cobrança, ela é confirmada com o
   * número na frente. Gratuito segue num clique só.
   */
  const ehEquipe = papel !== "CLIENTE";

  async function reprocess(cobrarCliente: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const orc = await fetch(`/api/analises/${id}/orcamento`).then((r) => r.json());
      const aCobrar: number = orc?.data?.aCobrar ?? 0;
      const quantia = aCobrar === 1 ? "1 crédito" : `${aCobrar} créditos`;

      /**
       * Só confirma quando há débito de verdade. Reprocessar o mesmo material é gratuito
       * e não deve pedir nada; a diferença de faixa é dinheiro e pede confirmação com o
       * número na frente — e, quando é a equipe agindo, dizendo DE QUEM é o crédito.
       */
      if (cobrarCliente && aCobrar > 0) {
        const pergunta = ehEquipe
          ? `Cobrar ${quantia} DO CLIENTE por este reprocessamento?\n\n` +
            `Os documentos mudaram de faixa de tamanho. Use isto apenas quando o próprio ` +
            `cliente pediu o reprocessamento com os documentos novos.\n\nContinuar?`
          : `Os documentos desta análise mudaram de faixa de tamanho.\n\n` +
            `Reprocessar vai debitar ${quantia} (a diferença; o que já foi pago não é ` +
            `cobrado outra vez).\n\nContinuar?`;
        if (!confirm(pergunta)) {
          setBusy(false);
          return;
        }
      }
    } catch {
      // Falha ao consultar o custo não impede reprocessar: a trava de saldo real está
      // no servidor. O que se perde é o aviso, e isso vai dito na mensagem.
      setMsg("Não conseguimos calcular o custo antes de reprocessar.");
    }

    const res = await fetch(`/api/analises/${id}/processar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cobrarCliente }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok && data.ok) {
      if (data.data?.message) setMsg(data.data.message);
      router.refresh();
    } else {
      setMsg(data.error ?? "Falha ao processar.");
    }
  }

  /**
   * ⚠️ A CONFIRMAÇÃO AVISA QUE EXCLUIR NÃO DEVOLVE O CRÉDITO — e antes não avisava.
   *
   * Excluir e Cancelar ficam lado a lado nesta barra e parecem alternativas do mesmo tipo. Não são:
   * Cancelar devolve o crédito quando nada foi entregue e preserva os documentos; Excluir apaga tudo e
   * não devolve nada. Quem tem uma análise que falhou quer justamente "se livrar dela" — e escolhia o
   * botão que custa dinheiro, sem nunca saber que havia outro caminho.
   *
   * O aviso só aparece quando há crédito de verdade em jogo (`creditoAPerder`, calculado no servidor pela
   * MESMA conta do estorno). Avisar sempre treinaria a pessoa a ignorar o aviso — inclusive na vez em que
   * ele importa.
   */
  async function remove() {
    const pergunta =
      creditoAPerder > 0
        ? `Excluir apaga esta análise e os documentos, e NÃO devolve crédito.\n\n` +
          `Esta análise tem ${creditoAPerder === 1 ? "1 crédito" : `${creditoAPerder} créditos`} que ` +
          `voltariam para o seu saldo se você usasse "Cancelar análise" em vez de excluir. Cancelar também ` +
          `mantém os documentos guardados.\n\n` +
          `Excluir mesmo assim, perdendo ${creditoAPerder === 1 ? "o crédito" : "os créditos"}?`
        : "Excluir esta análise e seus documentos? Esta ação é irreversível.";
    if (!confirm(pergunta)) return;
    setBusy(true);
    const res = await fetch(`/api/analises/${id}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) router.push("/analises");
    else setMsg("Falha ao excluir.");
  }

  /**
   * Cancelar, arquivar e desarquivar.
   *
   * ── Por que precisavam existir ────────────────────────────────────────────────
   * `CANCELADA` e `ARQUIVADA` existiam no banco, tinham selo colorido e apareciam nos manuais
   * publicados — e nenhum caminho do sistema chegava a elas. O resultado era um beco sem saída no
   * caminho do dinheiro: com a análise em erro e o limite de três reprocessamentos esgotado, o único
   * botão restante nesta barra era EXCLUIR, que apaga os documentos e não devolve crédito. A única
   * saída oferecida a quem pagou e não recebeu era destruir a prova de que pagou.
   *
   * Cancelar não apaga nada e devolve o crédito quando não houve entrega.
   */
  async function situacao(acao: "cancelar" | "arquivar" | "desarquivar") {
    if (acao === "cancelar") {
      /**
       * A confirmação diz o que acontece com o CRÉDITO — mas sem prometer devolução, porque quem
       * decide é o servidor (só devolve se não houve entrega). Prometer aqui e não cumprir lá seria
       * pior que não dizer nada.
       */
      const pergunta =
        "Cancelar esta análise?\n\n" +
        "Ela sai do fluxo, mas nada é apagado: os documentos e o histórico continuam guardados. Se a " +
        "análise não chegou a gerar relatório, o crédito volta para o seu saldo.";
      if (!confirm(pergunta)) return;
    }
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/analises/${id}/situacao`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acao }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok && data.ok) {
      setMsg(data.data?.message ?? "Pronto.");
      router.refresh();
    } else {
      setMsg(data.error ?? "Não foi possível concluir agora.");
      /**
       * ⚠️ Recarrega TAMBÉM na recusa.
       *
       * As recusas daqui são de ESTADO — a análise já mudou de situação, ou está processando agora. Sem
       * o recarregamento, o botão recusado continua na tela e a pessoa clica de novo, recebendo o mesmo
       * erro; e o pior caso é ela concluir que o produto está quebrado quando ele está apenas
       * desatualizado na tela dela. Recarregar traz a verdade e some com o botão que não cabe mais.
       */
      router.refresh();
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <a href={`/api/analises/${id}/relatorio?format=pdf`} className="btn-outline text-sm">Análise PDF</a>
      <a href={`/api/analises/${id}/relatorio?format=docx`} className="btn-outline text-sm">Análise DOCX</a>
      {temPeticao && (
        <>
          <a href={`/api/analises/${id}/peca?format=docx`} className="btn-outline text-sm">Petição (DOCX)</a>
          <a href={`/api/analises/${id}/peca?format=pdf`} className="btn-outline text-sm">Petição (PDF)</a>
        </>
      )}
      {/*
        Para a EQUIPE o botão comum não cobra o cliente — revisão e suporte são trabalho
        nosso, e antes um clique de revisor gastava crédito dele sem avisar ninguém.
        Cobrar em nome do cliente é um segundo botão, para não acontecer por acidente.
      */}
      {/*
        Reprocessar desaparece na análise encerrada. Não é só estética: a rota de processar gravaria
        PROCESSANDO numa análise CANCELADA — e como o cancelamento devolveu o crédito, a cobrança
        deixaria de ser idempotente e o cliente seria debitado OUTRA VEZ por uma análise que ele
        cancelou. Para retomar, desarquive (ou peça ao suporte reabrir).
      */}
      {!encerrada && (
        <>
          <button onClick={() => reprocess(!ehEquipe)} disabled={busy} className="btn-ghost text-sm">
            {busy ? "…" : ehEquipe ? "Reprocessar (sem cobrar)" : "Reprocessar"}
          </button>
          {ehEquipe && (
            <button onClick={() => reprocess(true)} disabled={busy} className="btn-ghost text-sm text-atencao">
              Reprocessar cobrando o cliente
            </button>
          )}
        </>
      )}
      {acoes.cancelar && (
        <button onClick={() => void situacao("cancelar")} disabled={busy} className="btn-ghost text-sm text-atencao">
          Cancelar análise
        </button>
      )}
      {acoes.arquivar && (
        <button onClick={() => void situacao("arquivar")} disabled={busy} className="btn-ghost text-sm">
          Arquivar
        </button>
      )}
      {acoes.desarquivar && (
        <button onClick={() => void situacao("desarquivar")} disabled={busy} className="btn-ghost text-sm">
          Desarquivar
        </button>
      )}
      <button onClick={remove} disabled={busy} className="btn-ghost text-sm text-alerta-700">Excluir</button>
      {msg && <span className="text-sm text-neutro-600">{msg}</span>}
    </div>
  );
}
