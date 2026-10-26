import { describe, it, expect } from "vitest";
import { montarOrcamento } from "../src/lib/orcamento";
import type { Subscription } from "@prisma/client";

/**
 * Orçamento da análise: o número que o cliente lê ANTES de autorizar o débito.
 *
 * ── Por que isto tem teste próprio ────────────────────────────────────────────
 * A tela de preenchimento manual anunciava "Consumo estimado: 1 análise do seu plano",
 * escrito à mão, enquanto o débito é por FAIXA DE PÁGINAS e chega a 4 créditos num
 * processo de mil páginas. Quem enviava processo grande lia "1", confirmava, e via
 * quatro créditos saírem. A Política de Créditos publica que o custo é informado antes
 * da confirmação — era promessa quebrada, não imprecisão de texto.
 *
 * E a REEXECUÇÃO tem conta própria: reprocessar o mesmo material é gratuito (regra do
 * produto), mas documentos acrescentados que mudam a faixa pagam a diferença. As duas
 * regras convivem, e é aqui que isso fica travado.
 *
 * Função pura: dá para provar cada caso sem banco e sem provedor.
 */

/** Assinatura mínima para o cálculo — só os campos de saldo importam. */
function assinatura(cota: number, usados = 0, extra = 0): Subscription {
  return { analysesQuota: cota, analysesUsed: usados, extraAnalyses: extra } as Subscription;
}

const mb = (n: number) => n * 1024 * 1024;
const processo = (paginas: number, megas = 5) => ({ paginas, bytes: mb(megas), arquivos: 1 });

describe("primeira análise", () => {
  it("anuncia o custo da FAIXA, não '1 análise'", () => {
    const o = montarOrcamento(processo(900), assinatura(20));
    expect(o.custo.creditos).toBe(4);
    expect(o.aCobrar).toBe(4);
    expect(o.mensagem).toContain("4 créditos");
    expect(o.saldoApos).toBe(16);
  });

  it("processo pequeno custa 1 crédito", () => {
    const o = montarOrcamento(processo(120), assinatura(20));
    expect(o.aCobrar).toBe(1);
    expect(o.mensagem).toContain("1 crédito");
  });

  it("sem saldo para a faixa, não deixa iniciar", () => {
    // Três créditos disponíveis, processo de 900 páginas custa quatro.
    const o = montarOrcamento(processo(900), assinatura(20, 17));
    expect(o.aCobrar).toBe(4);
    expect(o.podeIniciar).toBe(false);
  });

  it("processo acima do limite automático é bloqueado com orientação", () => {
    const o = montarOrcamento(processo(1200), assinatura(20));
    expect(o.custo.bloqueado).toBe(true);
    expect(o.podeIniciar).toBe(false);
    expect(o.mensagem).toMatch(/análise especial/i);
  });
});

describe("reexecução", () => {
  it("mesmo material não custa nada, e diz isso", () => {
    const o = montarOrcamento(processo(120), assinatura(20, 1), 1);
    expect(o.aCobrar).toBe(0);
    expect(o.mensagem).toContain("não consome créditos");
    expect(o.saldoApos).toBe(19);
  });

  it("gratuita mesmo com o saldo zerado — é a regra do produto", () => {
    /**
     * Quem gastou tudo é justamente quem mais precisa reexecutar a análise que já
     * pagou. A trava de saldo genérica barrava esse caso.
     */
    const o = montarOrcamento(processo(120), assinatura(20, 20), 1);
    expect(o.aCobrar).toBe(0);
    expect(o.podeIniciar).toBe(true);
  });

  it("documentos acrescentados cobram só a DIFERENÇA de faixa", () => {
    // Já pagou 1 (200 páginas); agora são 900, que custam 4.
    const o = montarOrcamento(processo(900), assinatura(20, 1), 1);
    expect(o.custo.creditos).toBe(4);
    expect(o.aCobrar).toBe(3);
    expect(o.mensagem).toContain("mais 3 créditos");
    // E o texto diz o que já foi pago, para o número não parecer arbitrário.
    expect(o.mensagem).toContain("já consumiu 1 crédito");
  });

  it("sem saldo para a diferença, não deixa reprocessar", () => {
    // Saldo 2, diferença necessária 3.
    const o = montarOrcamento(processo(900), assinatura(20, 18), 1);
    expect(o.aCobrar).toBe(3);
    expect(o.podeIniciar).toBe(false);
  });

  it("faixa que diminui não gera crédito a devolver nem cobrança", () => {
    // Pagou 4 e removeu documentos: agora custaria 1.
    const o = montarOrcamento(processo(120), assinatura(20, 4), 4);
    expect(o.aCobrar).toBe(0);
    expect(o.mensagem).toContain("não consome créditos");
  });
});

describe("plano legado sem limite", () => {
  it("não fala de crédito nenhum", () => {
    const o = montarOrcamento(processo(900), assinatura(0));
    expect(o.ilimitado).toBe(true);
    expect(o.podeIniciar).toBe(true);
    expect(o.mensagem).toContain("não tem limite");
  });
});
