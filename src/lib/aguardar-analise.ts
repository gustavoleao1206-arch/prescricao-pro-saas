/**
 * Espera pelo fim do processamento de uma análise, consultando o status.
 *
 * ── Por que vive aqui, e não dentro do componente ─────────────────────────────
 * Estava dentro de `auto-analysis.tsx`, junto do React e do roteador do Next, e por isso não
 * dava para exercitar por teste. A decisão que ela toma não é cosmética: distinguir
 * "processando", "falhou", "tempo esgotado" e "a sessão acabou" governa o que o cliente lê
 * depois de gastar crédito. Regra que decide isso precisa de teste, e teste precisa de módulo
 * sem árvore de componentes.
 *
 * ── O defeito que a saída "sessao" conserta ───────────────────────────────────
 * Acompanhar um processamento é espera PASSIVA, e de propósito não conta como presença no
 * encerramento por inatividade: a pessoa pode ter saído de perto, que é o caso que a regra
 * existe para pegar. Passando do prazo, esta consulta responde 401 — e antes o status vinha
 * indefinido, o laço seguia para a volta seguinte, e a tela girava até o teto de quatro minutos
 * para então dizer "tempo esgotado".
 *
 * Duas afirmações falsas ao mesmo tempo: o tempo não esgotou, e a análise não falhou — ela
 * continua correndo no servidor e vai terminar. O que acabou foi a sessão. E as duas mentiras
 * levam ao mesmo lugar errado: o cliente concluindo que perdeu o crédito.
 */

export type FimDaEspera = "pronto" | "erro" | "tempo" | "sessao";

/**
 * Estados em que o servidor considera a análise entregue ao cliente.
 *
 * ⚠️ Continha "REVISADA" e "ENTREGUE", que NÃO existem no enum `AnalysisStatus` — entradas
 * mortas, herdadas de uma versão anterior do fluxo. Não causavam falha (o que existe casa
 * corretamente), mas mentiam sobre a máquina de estados para quem lesse: fariam a próxima pessoa
 * acreditar em dois estados inexistentes, e é assim que se escreve código para um fluxo que não
 * é o real.
 *
 * Os dois que sobram são os dois que a análise de fato alcança ao terminar bem:
 * AGUARDANDO_REVISAO (fim do processamento) e CONCLUIDA (revisor aprovou).
 */
const PRONTOS = ["AGUARDANDO_REVISAO", "CONCLUIDA"];

export interface OpcoesDaEspera {
  /** Teto total, para a tela não girar sem fim. */
  tetoMs?: number;
  /** Intervalo entre consultas. */
  intervaloMs?: number;
  /** Injetados no teste; em produção são os globais. */
  buscar?: typeof fetch;
  esperar?: (ms: number) => Promise<void>;
  agora?: () => number;
}

export async function aguardarConclusao(id: string, opcoes: OpcoesDaEspera = {}): Promise<FimDaEspera> {
  const tetoMs = opcoes.tetoMs ?? 240_000;
  const intervaloMs = opcoes.intervaloMs ?? 2_500;
  const buscar = opcoes.buscar ?? fetch;
  const esperar = opcoes.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const agora = opcoes.agora ?? (() => Date.now());

  const inicio = agora();
  while (agora() - inicio < tetoMs) {
    await esperar(intervaloMs);
    try {
      const res = await buscar(`/api/analises/${id}`, { cache: "no-store" });
      /**
       * Sai na hora. Insistir não recupera sessão encerrada, e cada volta a mais é tempo de
       * alguém olhando uma tela que não vai mudar. É o único desfecho que exige coisa
       * diferente de quem lê: não é "tente de novo", é "entre de novo".
       */
      if (res.status === 401) return "sessao";
      const dados = (await res.json()) as { data?: { analysis?: { status?: string } } };
      const status = dados?.data?.analysis?.status;
      if (!status) continue;
      if (PRONTOS.includes(status)) return "pronto";
      if (status === "ERRO_PROCESSAMENTO") return "erro";
    } catch {
      /**
       * Falha de rede É transitória, e por isso continua tentando até o teto. A diferença em
       * relação ao 401 é a razão de os dois não poderem ser tratados juntos: um se resolve
       * esperando, o outro não se resolve nunca.
       */
    }
  }
  return "tempo";
}
