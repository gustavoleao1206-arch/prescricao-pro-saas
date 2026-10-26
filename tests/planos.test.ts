import { describe, it, expect } from "vitest";
import {
  PLANOS,
  PACOTES,
  CREDITOS_MENSAIS,
  DESCONTO_ANUAL,
  VALOR_UNITARIO_CREDITO_CENTS,
  economiaAnual,
  precoBR,
} from "../src/lib/planos";

/**
 * Catálogo comercial.
 *
 * O risco aqui não é o código quebrar, é o PREÇO mentir. Se alguém ajustar um
 * valor e o desconto anual cair abaixo dos 30% anunciados, o site passa a fazer
 * publicidade enganosa (art. 37 do CDC) sem que nada exploda. Estes testes fazem
 * esse erro aparecer na suíte.
 *
 * A oferta foi reformulada: eram quatro famílias escalonadas por quantidade de
 * créditos, hoje é um plano único SEM LIMITE em duas periodicidades. Por isso os
 * antigos testes de "escada de créditos" saíram — não existe mais escada — e
 * entraram no lugar as travas que a oferta nova exige.
 */

describe("a oferta é um plano único em duas periodicidades", () => {
  it("existem exatamente dois planos vendáveis", () => {
    const vendaveis = PLANOS.filter((p) => !p.contactOnly);
    expect(vendaveis).toHaveLength(2);
    expect(vendaveis.map((p) => p.period).sort()).toEqual(["ANUAL", "MENSAL"]);
  });

  it("o mensal custa R$ 49,90", () => {
    const mensal = PLANOS.find((p) => p.period === "MENSAL");
    expect(mensal?.priceCents).toBe(4990);
  });

  it("os dois pertencem à mesma família, para a grade agrupar corretamente", () => {
    const familias = new Set(PLANOS.filter((p) => !p.contactOnly).map((p) => p.family));
    expect(familias.size).toBe(1);
  });
});

describe("cota mensal de análises", () => {
  it("os dois planos vendem a mesma cota, e ela não é zero", () => {
    /**
     * Cota 0 tem significado PRÓPRIO no sistema: quer dizer SEM LIMITE — `saldoDe`
     * devolve `ilimitado: true`, `temSaldo` libera sempre e `consumirCreditos`
     * registra o uso sem debitar. A oferta já foi ilimitada e voltou a ter teto por
     * causa do custo por análise, então deixar um zero escapar aqui não daria erro:
     * daria acesso ilimitado silencioso, com o site anunciando 20.
     */
    const vendidos = PLANOS.filter((p) => !p.contactOnly);
    expect(vendidos.length).toBeGreaterThan(0);
    for (const plano of vendidos) {
      expect(plano.monthlyCredits, `${plano.slug} está com cota ZERO, que significa ILIMITADO`).toBe(
        CREDITOS_MENSAIS,
      );
      expect(CREDITOS_MENSAIS).toBeGreaterThan(0);
    }
  });

  it("o benefício anuncia a quantidade, e a quantidade é a do catálogo", () => {
    /**
     * O texto do cartão de plano é publicidade e vincula o fornecedor (arts. 30 e 37
     * do CDC). Este teste existe porque a oferta já mudou duas vezes: com cota,
     * anunciar "sem limite" seria falso; sem cota, anunciar um número seria falso. A
     * trava é o número BATER com `monthlyCredits`.
     */
    for (const plano of PLANOS.filter((p) => !p.contactOnly)) {
      const sobreAnalises = plano.benefits.filter((b) => /an[áa]lise/i.test(b));
      expect(sobreAnalises.length, `${plano.slug} não fala de análises`).toBeGreaterThan(0);

      const semLimite = sobreAnalises.find((b) => /sem limite|ilimitad/i.test(b));
      expect(semLimite, `${plano.slug}: benefício "${semLimite}" promete ilimitado num plano com cota`).toBeUndefined();

      const comQuantidade = sobreAnalises.find((b) => b.includes(String(plano.monthlyCredits)));
      expect(
        comQuantidade,
        `${plano.slug}: nenhum benefício cita a cota de ${plano.monthlyCredits} análises`,
      ).toBeTruthy();
    }
  });

  it("o crédito avulso existe e é mais caro que a análise embutida no plano", () => {
    /**
     * O avulso é a válvula do teto: passada a cota, o cliente compra em vez de
     * bater numa parede. Se ele custasse o mesmo (ou menos) que a análise já paga
     * dentro do plano, o plano perderia sentido — e se não existisse, o teto viraria
     * parede.
     */
    const mensal = PLANOS.find((p) => p.period === "MENSAL")!;
    const porAnaliseNoPlano = mensal.priceCents / mensal.monthlyCredits;
    expect(PACOTES.length).toBeGreaterThan(0);
    expect(VALOR_UNITARIO_CREDITO_CENTS).toBeGreaterThan(porAnaliseNoPlano);
  });
});

describe("desconto do plano anual", () => {
  it("o anual custa pelo menos 30% menos que 12 meses do mensal", () => {
    const mensal = PLANOS.find((p) => p.period === "MENSAL")!;
    const anual = PLANOS.find((p) => p.period === "ANUAL")!;

    const dozeMeses = mensal.priceCents * 12;
    const descontoReal = (dozeMeses - anual.priceCents) / dozeMeses;

    // "Pelo menos": arredondar o preço para baixo aumenta o desconto, o que é
    // seguro. O que não pode é ficar abaixo do que foi anunciado.
    expect(
      descontoReal,
      `desconto real de ${(descontoReal * 100).toFixed(2)}% — anunciado ${DESCONTO_ANUAL * 100}% ` +
        `(mensal ${precoBR(mensal.priceCents)} x12 = ${precoBR(dozeMeses)}, anual ${precoBR(anual.priceCents)})`,
    ).toBeGreaterThanOrEqual(DESCONTO_ANUAL);
  });

  it("a economia exibida na tela bate com os 30% anunciados", () => {
    // A tela arredonda para inteiro; não pode exibir menos que o prometido.
    expect(economiaAnual("prescricao-pro")).toBeGreaterThanOrEqual(DESCONTO_ANUAL * 100);
  });

  it("o anual não corta nada em relação ao mensal", () => {
    // Regra comercial: o anual é desconto no preço, nunca redução de entrega.
    const mensal = PLANOS.find((p) => p.period === "MENSAL")!;
    const anual = PLANOS.find((p) => p.period === "ANUAL")!;
    expect(anual.monthlyCredits).toBe(mensal.monthlyCredits);
    expect(anual.maxUsers).toBeGreaterThanOrEqual(mensal.maxUsers);
    expect(anual.priorityProcessing).toBe(mensal.priorityProcessing);
  });

  it("o anual sai mais barato por mês que o mensal", () => {
    const mensal = PLANOS.find((p) => p.period === "MENSAL")!;
    const anual = PLANOS.find((p) => p.period === "ANUAL")!;
    expect(anual.priceCents / 12).toBeLessThan(mensal.priceCents);
  });
});

describe("pacotes avulsos", () => {
  it("todos valem 90 dias", () => {
    for (const p of PACOTES) expect(p.validityDays).toBe(90);
  });

  it("o preço avulso é a quantidade vezes o valor unitário do crédito", () => {
    // Regra definida pelo dono: crédito avulso a R$ 5,00 a unidade, derivado
    // da constante única. Se alguém mudar o preço de um item avulso sem mudar
    // o valor unitário (ou vice-versa), este teste acusa.
    for (const pacote of PACOTES) {
      expect(pacote.priceCents, `${pacote.name}`).toBe(pacote.credits * VALOR_UNITARIO_CREDITO_CENTS);
    }
  });
});
