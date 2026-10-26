import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { iniciarOperacaoLonga, temOperacaoLonga, durante } from "../src/lib/operacao-em-andamento";

/**
 * Operação longa em andamento — a condição que impede o relógio de inatividade de cortar um
 * envio de documento pela metade.
 *
 * ── O defeito ─────────────────────────────────────────────────────────────────
 * O encerramento por inatividade conta interação real: clique, tecla, rolagem, toque. Subir um
 * documento não gera nenhum dos quatro — a pessoa escolhe o arquivo, manda, e espera. Um PDF
 * de execução fiscal com centenas de páginas em conexão comum leva minutos, e passando do
 * prazo a tela navegava para o login NO MEIO DO ENVIO: a requisição em voo morria com a
 * navegação e o documento se perdia. Com 10 minutos de prazo para a equipe, uso normal.
 *
 * ── O que se prova aqui, e o que NÃO ──────────────────────────────────────────
 * Aqui se prova a CONTA: começar, terminar, aninhar, e soltar o contador mesmo quando a
 * operação falha. É a parte que decide, e é a que erra em silêncio — contador que não zera
 * desliga o encerramento por inatividade para sempre.
 *
 * O que este arquivo NÃO cobre é o componente de tela que consulta esta conta: ele depende de
 * `window`, de `setInterval` e de navegação do Next. Está verificado por leitura, não por
 * execução, e isso fica dito em vez de subentendido.
 */

/**
 * O contador é estado de MÓDULO — compartilhado entre os testes por construção. Não existe
 * função de reiniciar, e não deve existir: seam só para teste é código que mente sobre o que
 * o sistema faz.
 *
 * Então cada teste equilibra a própria conta, e estas duas guardas garantem isso: a de antes
 * prova que o teste começa limpo, a de depois prova que ele não vazou. Vazamento aqui
 * contaminaria os seguintes de um jeito difícil de ler — o teste erraria e a causa estaria em
 * outro arquivo do mesmo bloco.
 */
beforeEach(() => {
  expect(temOperacaoLonga()).toBe(false);
});

afterEach(() => {
  expect(temOperacaoLonga()).toBe(false);
});

describe("a conta de operações longas", () => {
  it("começa sem nenhuma", () => {
    expect(temOperacaoLonga()).toBe(false);
  });

  it("marca durante, e solta no fim", () => {
    const encerrar = iniciarOperacaoLonga();
    expect(temOperacaoLonga()).toBe(true);

    encerrar();
    expect(temOperacaoLonga()).toBe(false);
  });

  it("duas operações em paralelo: a primeira a terminar NÃO libera o relógio", () => {
    /**
     * O caso real: dois arquivos subindo. Se o fim do primeiro zerasse a conta, o relógio
     * voltaria a valer com o segundo ainda em voo — e cortaria justamente o arquivo maior.
     */
    const primeira = iniciarOperacaoLonga();
    const segunda = iniciarOperacaoLonga();

    primeira();
    expect(temOperacaoLonga()).toBe(true);

    segunda();
    expect(temOperacaoLonga()).toBe(false);
  });

  it("encerrar duas vezes não rouba a conta de outra operação", () => {
    /**
     * Sem a idempotência, um `finally` que rodasse duas vezes (ou um encerramento chamado à
     * mão junto do automático) zeraria a conta de uma operação alheia — e o envio dela seria
     * cortado por um erro em outro lugar.
     */
    const primeira = iniciarOperacaoLonga();
    const segunda = iniciarOperacaoLonga();

    primeira();
    primeira();
    expect(temOperacaoLonga()).toBe(true);

    segunda();
    expect(temOperacaoLonga()).toBe(false);
  });

  it("nunca fica negativo — conta furada desligaria a proteção para sempre", () => {
    const encerrar = iniciarOperacaoLonga();
    encerrar();
    encerrar();
    encerrar();

    // Se tivesse ido a -2, a próxima operação real ainda deixaria a conta em zero.
    const nova = iniciarOperacaoLonga();
    expect(temOperacaoLonga()).toBe(true);
    nova();
    expect(temOperacaoLonga()).toBe(false);
  });
});

describe("durante()", () => {
  it("marca enquanto a operação corre e solta no sucesso", async () => {
    let dentro = false;

    const r = await durante(async () => {
      dentro = temOperacaoLonga();
      return "pronto";
    });

    expect(dentro).toBe(true);
    expect(r).toBe("pronto");
    expect(temOperacaoLonga()).toBe(false);
  });

  it("⚠️ solta o contador também quando a operação FALHA", async () => {
    /**
     * O caminho que mais importa. Envio que estoura o tamanho, rede que cai, arquivo
     * corrompido — se o contador ficasse preso, o encerramento por inatividade estaria
     * desligado para o resto da sessão daquela aba, sem nada indicando isso.
     */
    await expect(
      durante(async () => {
        throw new Error("rede caiu no meio do envio");
      }),
    ).rejects.toThrow("rede caiu");

    expect(temOperacaoLonga()).toBe(false);
  });
});
