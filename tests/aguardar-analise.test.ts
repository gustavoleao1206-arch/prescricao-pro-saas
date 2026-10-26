import { describe, it, expect } from "vitest";
import { aguardarConclusao } from "../src/lib/aguardar-analise";

/**
 * A espera pelo fim do processamento, e o que a tela diz em cada desfecho.
 *
 * ── O defeito ─────────────────────────────────────────────────────────────────
 * Acompanhar um processamento é espera PASSIVA, e de propósito não conta como presença no
 * encerramento por inatividade: a pessoa pode ter saído de perto, que é o caso que a regra
 * existe para pegar. Passando do prazo, a consulta de status responde 401 — e antes o status
 * vinha indefinido, o laço seguia para a volta seguinte, e a tela girava até o teto de quatro
 * minutos para então dizer "tempo esgotado".
 *
 * Duas afirmações falsas ao mesmo tempo: o tempo não esgotou, e a análise não falhou — ela
 * continua correndo no servidor e vai terminar. E as duas levam ao mesmo lugar errado: o
 * cliente concluindo que perdeu o crédito.
 *
 * ── Por que a função saiu do componente ───────────────────────────────────────
 * Ela vivia dentro de `auto-analysis.tsx`, junto do React e do roteador do Next, e por isso não
 * dava para exercitar. A decisão que ela toma governa o que o cliente lê depois de gastar
 * crédito; regra assim precisa de teste, e teste precisa de módulo sem árvore de componentes.
 */

/** Respostas encadeadas, uma por consulta, para o teste desenhar o cenário. */
function respostas(...seq: Array<{ status: number; corpo?: unknown } | "erro-de-rede">) {
  let i = 0;
  const chamadas: string[] = [];
  const buscar = (async (url: string | URL) => {
    chamadas.push(String(url));
    const atual = seq[Math.min(i, seq.length - 1)];
    i++;
    if (atual === "erro-de-rede") throw new Error("rede caiu");
    return {
      status: atual!.status,
      json: async () => atual!.corpo ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { buscar, chamadas: () => chamadas };
}

/** Relógio e espera controlados: o teste não pode levar quatro minutos de verdade. */
function relogio() {
  let t = 0;
  return {
    agora: () => t,
    esperar: async (ms: number) => {
      t += ms;
    },
  };
}

const analise = (status: string) => ({ status: 200, corpo: { data: { analysis: { status } } } });

describe("desfechos da espera", () => {
  it("análise pronta devolve 'pronto'", async () => {
    const r = relogio();
    const { buscar } = respostas(analise("PROCESSANDO"), analise("AGUARDANDO_REVISAO"));

    expect(await aguardarConclusao("a1", { buscar, ...r })).toBe("pronto");
  });

  it("análise com erro devolve 'erro'", async () => {
    const r = relogio();
    const { buscar } = respostas(analise("ERRO_PROCESSAMENTO"));

    expect(await aguardarConclusao("a2", { buscar, ...r })).toBe("erro");
  });

  it("nunca termina dentro do teto devolve 'tempo'", async () => {
    const r = relogio();
    const { buscar } = respostas(analise("PROCESSANDO"));

    expect(await aguardarConclusao("a3", { buscar, ...r, tetoMs: 20_000, intervaloMs: 2_500 })).toBe("tempo");
  });
});

describe("sessão encerrada durante a espera", () => {
  it("⚠️ 401 devolve 'sessao' — não 'tempo', não 'erro'", async () => {
    /**
     * O conserto. Antes o 401 caía no `continue` e o desfecho era "tempo": a tela girava quatro
     * minutos e então dizia que o tempo esgotou, o que é falso, e que a análise falhou com
     * estorno automático, o que é pior — o crédito comprou uma análise que está sendo entregue.
     */
    const r = relogio();
    const { buscar } = respostas({ status: 401 });

    expect(await aguardarConclusao("a4", { buscar, ...r })).toBe("sessao");
  });

  it("sai na PRIMEIRA consulta, sem insistir até o teto", async () => {
    /**
     * Insistir não recupera sessão encerrada, e cada volta a mais é tempo de alguém olhando uma
     * tela que não vai mudar. Uma consulta e sai.
     */
    const r = relogio();
    const { buscar, chamadas } = respostas({ status: 401 });

    await aguardarConclusao("a5", { buscar, ...r, tetoMs: 240_000 });

    expect(chamadas()).toHaveLength(1);
  });

  it("401 no MEIO da espera também encerra, não só na primeira", async () => {
    const r = relogio();
    const { buscar, chamadas } = respostas(analise("PROCESSANDO"), analise("PROCESSANDO"), { status: 401 });

    expect(await aguardarConclusao("a6", { buscar, ...r })).toBe("sessao");
    expect(chamadas()).toHaveLength(3);
  });
});

describe("falha de rede é diferente de sessão encerrada", () => {
  it("⚠️ erro de rede NÃO encerra: continua tentando e conclui", async () => {
    /**
     * A distinção que justifica os dois desfechos serem separados: falha de rede se resolve
     * esperando, sessão encerrada não se resolve nunca. Tratar as duas juntas obrigaria a
     * escolher entre desistir de quem só teve uma oscilação, ou fazer quem foi desconectado
     * esperar quatro minutos por nada.
     */
    const r = relogio();
    const { buscar } = respostas("erro-de-rede", "erro-de-rede", analise("CONCLUIDA"));

    expect(await aguardarConclusao("a7", { buscar, ...r })).toBe("pronto");
  });

  it("rede fora até o fim devolve 'tempo', e não 'sessao'", async () => {
    // Sem sessão encerrada em lugar nenhum, dizer "entre de novo" mandaria a pessoa ao lugar
    // errado — o problema é a conexão dela.
    const r = relogio();
    const { buscar } = respostas("erro-de-rede");

    expect(await aguardarConclusao("a8", { buscar, ...r, tetoMs: 15_000 })).toBe("tempo");
  });
});
