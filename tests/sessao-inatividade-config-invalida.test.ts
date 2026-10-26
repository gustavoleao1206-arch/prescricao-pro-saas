import { describe, it, expect } from "vitest";

/**
 * Configuração inválida do prazo de inatividade — e por que este arquivo é separado.
 *
 * ── O defeito que ele trava ───────────────────────────────────────────────────
 * `env` lê os minutos com `Number(...)`, e `Number("abc")` é `NaN`. `NaN` perde TODA
 * comparação numérica: `NaN <= 0` é falso, então a saída de "regra desligada" não pegava, e
 * `decorrido > NaN * 60000` também é falso — nenhuma sessão era considerada inativa.
 *
 * Resultado: um dedo torto em `SESSION_IDLE_MINUTES` desligava o encerramento por inatividade
 * INTEIRO, sem uma linha de erro em lugar nenhum, enquanto a tela de login continuaria
 * dizendo que a sessão é encerrada por segurança. Falha silenciosa que se apresenta como
 * proteção ativa é o pior desfecho possível para uma regra de segurança.
 *
 * Valor negativo tinha o mesmo efeito por outro caminho.
 *
 * ── Por que arquivo próprio ───────────────────────────────────────────────────
 * `env` é montado UMA vez, na carga do módulo, a partir de `process.env`. Trocar a variável no
 * meio de um arquivo não muda o valor já capturado — e o resto dos testes de sessão precisa
 * dos valores VÁLIDOS para medir a regra. Ambiente diferente, arquivo diferente.
 *
 * Não precisa de banco: só a conta dos minutos é exercitada aqui.
 */

process.env.SESSION_IDLE_MINUTES = "trinta";
process.env.SESSION_IDLE_MINUTES_EQUIPE = "-5";

const { INATIVIDADE_MINUTOS, sessaoInativa } = await import("../src/lib/auth");
const { env } = await import("../src/lib/env");

describe("prazo de inatividade com configuração inválida", () => {
  it("o valor lido é REALMENTE inutilizável — senão o teste não mediria nada", () => {
    // Sanidade: sem isto, o arquivo poderia passar afirmando o padrão sobre um valor válido.
    expect(Number.isNaN(env.sessionIdleMinutes)).toBe(true);
    expect(env.sessionIdleMinutesEquipe).toBe(-5);
  });

  it("cai no PADRÃO do código, não em 'regra desligada'", () => {
    expect(INATIVIDADE_MINUTOS("CLIENTE")).toBe(30);
    expect(INATIVIDADE_MINUTOS("ADMIN")).toBe(10);
  });

  it("e a regra continua ENCERRANDO sessão parada", () => {
    /**
     * A asserção que importa. Antes do conserto, `sessaoInativa` devolvia false para qualquer
     * tempo de parada — inclusive um dia inteiro —, porque a comparação com `NaN` é sempre
     * falsa. A proteção existia no papel e não existia na execução.
     */
    const umDiaParada = new Date(Date.now() - 24 * 60 * 60_000);
    expect(sessaoInativa({ lastSeenAt: umDiaParada, role: "CLIENTE" })).toBe(true);
    expect(sessaoInativa({ lastSeenAt: umDiaParada, role: "ADMIN" })).toBe(true);

    // E não encerra quem acabou de usar: o padrão é um prazo, não um interruptor.
    const agoraMesmo = new Date();
    expect(sessaoInativa({ lastSeenAt: agoraMesmo, role: "CLIENTE" })).toBe(false);
    expect(sessaoInativa({ lastSeenAt: agoraMesmo, role: "ADMIN" })).toBe(false);
  });
});
