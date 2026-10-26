import { describe, it, expect } from "vitest";
import { tempoDeEspera } from "../src/lib/rate-limit";

/**
 * A recusa por limite tem de dizer QUANTO esperar.
 *
 * ── O achado ──────────────────────────────────────────────────────────────────
 * Todas as recusas por limite diziam alguma variação de "aguarde alguns minutos" — inclusive a do
 * cadastro, cuja janela é de uma HORA. Quem lê "alguns minutos" volta em dois, é recusado, volta em
 * cinco, é recusado, e fecha a aba. E as pessoas que batem nesses limites são justamente as que
 * estão tentando consertar o próprio acesso para poder pagar: reenvio de confirmação, recuperação de
 * senha, troca de e-mail.
 *
 * O número sempre existiu: `rateLimit` devolve `resetAt` desde o começo, e nenhuma rota o lia.
 *
 * ── Por que arredondar para CIMA é a decisão, e não um detalhe ─────────────────
 * Prometer menos espera do que a real faz a pessoa voltar cedo e ser recusada DE NOVO — e a segunda
 * recusa é a que ensina a não acreditar no que a tela diz. Errar para mais custa uma espera
 * desnecessária; errar para menos custa a confiança no produto. Os testes abaixo travam a direção do
 * arredondamento, não só o formato do texto.
 */

const AGORA = new Date("2026-08-10T12:00:00.000Z").getTime();
const emSegundos = (s: number) => tempoDeEspera(AGORA + s * 1000, AGORA);

describe("arredonda para cima, sempre", () => {
  it("⚠️ 61 segundos NÃO viram '1 minuto' — viram 2", () => {
    /**
     * A asserção que trava a direção. Com `Math.round`, 61 segundos viraria "1 minuto": a pessoa
     * voltaria depois de um minuto e seria recusada, porque ainda faltava um segundo. É pouco tempo
     * e é a diferença entre a tela acertar e a tela mentir.
     */
    expect(emSegundos(61)).toBe("cerca de 2 minutos");
    expect(emSegundos(90)).toBe("cerca de 2 minutos");
    expect(emSegundos(120)).toBe("cerca de 2 minutos");
  });

  it("121 segundos já são 3 minutos", () => {
    expect(emSegundos(121)).toBe("cerca de 3 minutos");
  });

  it("nunca diz menos de um minuto — não vale mandar voltar em segundos", () => {
    /**
     * "Aguarde cerca de 4 segundos" convida ao clique imediato, que é recusado de novo por causa do
     * arredondamento do próprio balde. Um minuto é o menor prazo que se pode prometer sem errar.
     */
    expect(emSegundos(1)).toBe("cerca de 1 minuto");
    expect(emSegundos(59)).toBe("cerca de 1 minuto");
    expect(emSegundos(60)).toBe("cerca de 1 minuto");
  });

  it("prazo já vencido devolve o mínimo, não um número negativo", () => {
    /**
     * Acontece de verdade: o balde vira entre a decisão de recusar e a montagem da mensagem.
     *
     * ⚠️ HONESTIDADE SOBRE O QUE ESTE TESTE MEDE: ele trava a SAÍDA, não o `Math.max(0, …)`. Apagando o
     * clamp, o valor negativo cai no ramo `segundos <= 60` e a resposta continua "cerca de 1 minuto" —
     * as duas versões dão o mesmo texto para toda entrada, então nenhum teste poderia distinguí-las.
     * O clamp fica porque documenta a intenção e sobrevive a uma mudança futura no primeiro ramo.
     */
    expect(emSegundos(-500)).toBe("cerca de 1 minuto");
    expect(emSegundos(-500)).not.toContain("-");
  });
});

describe("as janelas reais das rotas", () => {
  it("15 minutos — reenvio de confirmação e troca de e-mail", () => {
    expect(emSegundos(900)).toBe("cerca de 15 minutos");
  });

  it("10 minutos — recuperação de senha e confirmação da troca", () => {
    expect(emSegundos(600)).toBe("cerca de 10 minutos");
  });

  it("⚠️ 1 hora — o cadastro, que era o pior 'tente mais tarde' de todos", () => {
    /**
     * A janela mais longa do sistema estava na porta de entrada de cliente novo, com a mensagem mais
     * vaga: "tente mais tarde". Sessenta minutos é o teto exato desse balde.
     */
    expect(emSegundos(3600)).toBe("cerca de 1 hora");
    // E não "60 minutos", que se lê como se fosse pouco.
    expect(emSegundos(3600)).not.toContain("minuto");
  });

  it("59 minutos ainda são minutos; 61 já são horas", () => {
    expect(emSegundos(59 * 60)).toBe("cerca de 59 minutos");
    expect(emSegundos(61 * 60)).toBe("cerca de 2 horas");
  });
});

describe("o padrão é o relógio de agora", () => {
  it("sem passar `agora`, mede a partir do instante da chamada", () => {
    /**
     * As rotas chamam com um argumento só. Se o padrão não fosse o relógio atual, toda mensagem em
     * produção sairia com um prazo calculado a partir da época Unix — e ninguém notaria em teste que
     * passa `agora` explicitamente.
     */
    expect(tempoDeEspera(Date.now() + 5 * 60_000)).toBe("cerca de 5 minutos");
  });
});
