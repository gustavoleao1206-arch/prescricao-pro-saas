import { describe, it, expect } from "vitest";
import { calcularProporcional, diasDoPeriodo, ehSubidaDePlano, planoTrocavel, MINIMO_COBRANCA_CENTS } from "../src/lib/mudanca-plano";

/**
 * Cálculo proporcional da troca de plano.
 *
 * É a conta que o cliente lê na tela antes de autorizar a cobrança, então erro
 * aqui é cobrança indevida — e cobrança indevida em produto por assinatura é
 * problema jurídico, não só de suporte. A função é pura de propósito: dá para
 * provar cada caso sem banco e sem provedor.
 *
 * Datas são passadas explicitamente; nada aqui depende do relógio da máquina.
 */

// Faixas antigas: continuam existindo em assinaturas contratadas antes da
// reformulação da oferta, então a conta ainda precisa funcionar para elas.
const ESSENCIAL = { priceCents: 3990, monthlyAnalyses: 2, period: "MENSAL" as const };
const PROFISSIONAL = { priceCents: 11990, monthlyAnalyses: 8, period: "MENSAL" as const };
const ANUAL = { priceCents: 119900, monthlyAnalyses: 8, period: "ANUAL" as const };

// Oferta atual: plano único SEM LIMITE (cota 0) em duas periodicidades.
const MENSAL_ILIMITADO = { priceCents: 4990, monthlyAnalyses: 0, period: "MENSAL" as const };
const ANUAL_ILIMITADO = { priceCents: 41900, monthlyAnalyses: 0, period: "ANUAL" as const };

const ciclo = (fim: string | null) => ({ currentPeriodEnd: fim ? new Date(fim) : null });

describe("duração do ciclo", () => {
  it("usa 30 dias no mensal e 365 no anual", () => {
    expect(diasDoPeriodo("MENSAL")).toBe(30);
    expect(diasDoPeriodo("ANUAL")).toBe(365);
    // Período ausente cai no mensal, que é o padrão do produto.
    expect(diasDoPeriodo(null)).toBe(30);
  });
});

describe("upgrade", () => {
  it("cobra a diferença proporcional aos dias restantes", () => {
    // Ciclo até 31/07, hoje é 16/07 → 15 dias restantes de 30.
    const c = calcularProporcional(ESSENCIAL, PROFISSIONAL, ciclo("2026-07-31"), new Date("2026-07-16"));

    expect(c.ehUpgrade).toBe(true);
    expect(c.diasRestantes).toBe(15);
    expect(c.diferencaCheiaCents).toBe(8000); // 119,90 - 39,90
    expect(c.valorCents).toBe(4000); // metade do ciclo → metade da diferença
    expect(c.cobrancaDispensada).toBe(false);
    // Passa a valer na hora, não no fim do ciclo.
    expect(c.valeApartirDe).toBeNull();
  });

  it("entrega a diferença CHEIA de créditos, mesmo pagando fração", () => {
    const c = calcularProporcional(ESSENCIAL, PROFISSIONAL, ciclo("2026-07-31"), new Date("2026-07-21"));
    // 10 dias de 30 → paga um terço…
    expect(c.valorCents).toBe(Math.round(8000 / 3));
    // …e recebe os 6 créditos de diferença inteiros. Crédito de plano expira no
    // fim do ciclo, então proporcionalizar a cota entregaria quase nada.
    expect(c.creditosAdicionais).toBe(6);
  });

  it("cobra quase a diferença cheia quando o ciclo acabou de começar", () => {
    const c = calcularProporcional(ESSENCIAL, PROFISSIONAL, ciclo("2026-08-15"), new Date("2026-07-16"));
    expect(c.diasRestantes).toBe(30);
    expect(c.valorCents).toBe(8000);
  });

  it("dispensa a cobrança quando o proporcional fica abaixo do piso do gateway", () => {
    // Falta 1 dia: 8000 / 30 = 267 centavos, abaixo do piso.
    const c = calcularProporcional(ESSENCIAL, PROFISSIONAL, ciclo("2026-07-31"), new Date("2026-07-30"));

    expect(c.diasRestantes).toBe(1);
    expect(c.cobrancaDispensada).toBe(true);
    expect(c.valorCents).toBe(0);
    expect(MINIMO_COBRANCA_CENTS).toBeGreaterThan(267);
    // Os créditos continuam entrando: o cliente pediu o plano maior.
    expect(c.creditosAdicionais).toBe(6);
  });

  it("não cobra nada quando o ciclo já terminou", () => {
    const c = calcularProporcional(ESSENCIAL, PROFISSIONAL, ciclo("2026-07-10"), new Date("2026-07-16"));
    expect(c.diasRestantes).toBe(0);
    expect(c.valorCents).toBe(0);
    // Não é "dispensa": não havia proporcional a cobrar.
    expect(c.cobrancaDispensada).toBe(false);
  });

  it("não cobra nada quando não há data de fim de ciclo registrada", () => {
    const c = calcularProporcional(ESSENCIAL, PROFISSIONAL, ciclo(null), new Date("2026-07-16"));
    expect(c.diasRestantes).toBe(0);
    expect(c.valorCents).toBe(0);
  });

  it("nunca cobra mais do que a diferença cheia, mesmo com ciclo esticado", () => {
    // currentPeriodEnd muito à frente (dado inconsistente ou período alterado à
    // mão) não pode virar cobrança acima da diferença entre os planos.
    const c = calcularProporcional(ESSENCIAL, PROFISSIONAL, ciclo("2027-07-31"), new Date("2026-07-16"));
    expect(c.diasRestantes).toBe(30);
    expect(c.valorCents).toBe(8000);
    expect(c.valorCents).toBeLessThanOrEqual(c.diferencaCheiaCents);
  });

  it("a base do ciclo é a periodicidade do plano ATUAL, não a do novo", () => {
    /**
     * Este teste afirmava o contrário e passava — exigia base de 365 dias numa
     * troca que parte de um plano MENSAL. Era o teste concordando com o defeito:
     * o código usava o período do plano novo, e mensal → anual calculava a fração
     * sobre 365 dias, cobrando uma ninharia por um ano inteiro.
     *
     * Os dias que sobram são dias do ciclo que o cliente PAGOU, e ele pagou um
     * mês. Quando a periodicidade muda, a conta é outra — ver o bloco "troca de
     * periodicidade".
     */
    const c = calcularProporcional(ESSENCIAL, ANUAL, ciclo("2026-12-31"), new Date("2026-07-02"));
    expect(c.diasNoCiclo).toBe(30);
    expect(c.diasRestantes).toBe(30);
    expect(c.mudaPeriodo).toBe(true);
    // Anual cheio menos o mês pago inteiro, não uma fração do anual.
    expect(c.valorCents).toBe(119900 - 3990);
  });

  it("num upgrade entre dois planos ANUAIS a base é 365 dias", () => {
    const anualMaior = { priceCents: 200000, monthlyAnalyses: 20, period: "ANUAL" as const };
    // Ciclo anual até 31/12; hoje 02/07 → 182 dias restantes de 365.
    const c = calcularProporcional(ANUAL, anualMaior, ciclo("2026-12-31"), new Date("2026-07-02"));
    expect(c.mudaPeriodo).toBe(false);
    expect(c.diasNoCiclo).toBe(365);
    expect(c.diasRestantes).toBe(182);
    expect(c.valorCents).toBe(Math.round((200000 - 119900) * (182 / 365)));
  });

  it("troca de mesmo preço vale na hora e não cobra", () => {
    const outro = { priceCents: 3990, monthlyAnalyses: 4, period: "MENSAL" as const };
    const c = calcularProporcional(ESSENCIAL, outro, ciclo("2026-07-31"), new Date("2026-07-16"));
    expect(c.ehUpgrade).toBe(true);
    expect(c.valorCents).toBe(0);
    expect(c.creditosAdicionais).toBe(2);
  });
});

describe("downgrade", () => {
  it("não cobra nada e passa a valer no fim do ciclo pago", () => {
    const c = calcularProporcional(PROFISSIONAL, ESSENCIAL, ciclo("2026-07-31"), new Date("2026-07-16"));

    expect(c.ehUpgrade).toBe(false);
    expect(c.valorCents).toBe(0);
    expect(c.cobrancaDispensada).toBe(false);
    // Nada de crédito a somar: a cota do ciclo pago continua a do plano maior.
    expect(c.creditosAdicionais).toBe(0);
    expect(c.valeApartirDe).toEqual(new Date("2026-07-31"));
  });

  it("não gera devolução proporcional", () => {
    // Descer de plano no dia 2 do ciclo não devolve dinheiro: o mês foi contratado
    // no plano maior e é entregue no plano maior até o fim.
    const c = calcularProporcional(PROFISSIONAL, ESSENCIAL, ciclo("2026-08-15"), new Date("2026-07-17"));
    expect(c.valorCents).toBe(0);
    expect(c.diferencaCheiaCents).toBe(0);
  });
});

describe("elegibilidade do plano", () => {
  it("aceita plano ativo que não seja sob consulta", () => {
    expect(planoTrocavel({ active: true, contactOnly: false })).toBe(true);
  });

  it("recusa plano inativo e plano sob consulta", () => {
    expect(planoTrocavel({ active: false, contactOnly: false })).toBe(false);
    // Plano sob consulta tem condição negociada e não cabe em cálculo automático.
    expect(planoTrocavel({ active: true, contactOnly: true })).toBe(false);
  });
});

describe("troca de periodicidade — mensal para anual", () => {
  /**
   * O caso que estava ERRADO antes desta regra existir.
   *
   * O cálculo usava o período do plano NOVO como base do ciclo. Mensal → anual
   * faltando 20 dias virava `(419,00 − 49,90) × 20/365` = R$ 20,23 por um ano
   * inteiro de plano. Trocar de periodicidade não é pagar a diferença pelos dias
   * que faltam: é contratar um período novo.
   */
  it("cobra o preço do anual abatendo o que sobrou do mês pago", () => {
    // Ciclo mensal até 31/07; hoje é 11/07 → 20 dias restantes de 30.
    const c = calcularProporcional(MENSAL_ILIMITADO, ANUAL_ILIMITADO, ciclo("2026-07-31"), new Date("2026-07-11"));

    expect(c.mudaPeriodo).toBe(true);
    expect(c.diasNoCiclo).toBe(30);
    expect(c.diasRestantes).toBe(20);

    // Crédito pelos 20 dias não usados: R$ 49,90 × 20/30 = R$ 33,27.
    expect(c.creditoDoCicloAtualCents).toBe(Math.round(4990 * (20 / 30)));
    // Paga o anual menos esse crédito.
    expect(c.valorCents).toBe(41900 - c.creditoDoCicloAtualCents);

    // E o absurdo antigo não pode voltar: o valor tem de ser da ordem do anual.
    expect(c.valorCents).toBeGreaterThan(30000);
    expect(c.valorCents).toBeLessThanOrEqual(41900);
  });

  it("o novo ciclo passa a ser de um ano contado de hoje", () => {
    const hoje = new Date("2026-07-11");
    const c = calcularProporcional(MENSAL_ILIMITADO, ANUAL_ILIMITADO, ciclo("2026-07-31"), hoje);
    expect(c.novoCicloAte).not.toBeNull();
    const dias = Math.round((c.novoCicloAte!.getTime() - hoje.getTime()) / 86_400_000);
    expect(dias).toBe(365);
  });

  it("sem dias sobrando, paga o anual cheio", () => {
    const c = calcularProporcional(MENSAL_ILIMITADO, ANUAL_ILIMITADO, ciclo("2026-07-10"), new Date("2026-07-11"));
    expect(c.creditoDoCicloAtualCents).toBe(0);
    expect(c.valorCents).toBe(41900);
  });

  it("nunca cobra mais que o preço do anual", () => {
    const c = calcularProporcional(MENSAL_ILIMITADO, ANUAL_ILIMITADO, ciclo("2026-08-31"), new Date("2026-07-11"));
    expect(c.valorCents).toBeLessThanOrEqual(41900);
  });
});

describe("troca de periodicidade — anual para mensal", () => {
  it("não cobra e agenda para o fim do ano já pago", () => {
    const c = calcularProporcional(ANUAL_ILIMITADO, MENSAL_ILIMITADO, ciclo("2027-06-30"), new Date("2026-08-01"));
    expect(c.ehUpgrade).toBe(false);
    expect(c.valorCents).toBe(0);
    // Quem pagou um ano usa o ano inteiro; não há devolução proporcional.
    expect(c.valeApartirDe).toEqual(new Date("2027-06-30"));
  });
});

/**
 * Quem sobe e quem desce — a pergunta que duas partes do sistema respondiam de forma
 * diferente.
 *
 * O cálculo proporcional comparava PREÇO; a troca pelo checkout comparava COTA DE
 * CRÉDITOS. Enquanto os planos tinham cotas diferentes, as duas concordavam por
 * acidente. A oferta atual são dois planos com a MESMA cota (20 análises/mês) em duas
 * periodicidades: comparar cota passou a responder sempre "é upgrade" — e o ramo de
 * upgrade RECOMEÇA o período. Quem tinha o anual pago até agosto e comprava o mensal
 * perdia onze meses de serviço já pago num clique.
 */
describe("critério de subida de plano", () => {
  it("é o PREÇO que decide, não a cota", () => {
    const anual = { priceCents: 41900 };
    const mensal = { priceCents: 4990 };
    expect(ehSubidaDePlano(anual, mensal)).toBe(false);
    expect(ehSubidaDePlano(mensal, anual)).toBe(true);
  });

  it("cota igual e preço maior é subida — o caso que a comparação por cota errava", () => {
    // Exatamente a oferta de hoje: 20 créditos nos dois, preços muito diferentes.
    expect(ehSubidaDePlano({ priceCents: 4990 }, { priceCents: 41900 })).toBe(true);
    expect(ehSubidaDePlano({ priceCents: 41900 }, { priceCents: 4990 })).toBe(false);
  });

  it("mesmo preço conta como subida: não há diferença a devolver nem a agendar", () => {
    expect(ehSubidaDePlano({ priceCents: 4990 }, { priceCents: 4990 })).toBe(true);
  });
});

describe("plano sem limite de créditos", () => {
  it("não tenta somar cota quando o plano novo é ilimitado", () => {
    // Cota 0 significa SEM LIMITE. Subtrair (0 − 6) daria negativo, e tratar o
    // ilimitado como número faria o cliente perder o "sem limite".
    const c = calcularProporcional(PROFISSIONAL, MENSAL_ILIMITADO, ciclo("2026-07-31"), new Date("2026-07-16"));
    expect(c.creditosAdicionais).toBe(0);
  });

  it("não tenta somar cota quando o plano atual já é ilimitado", () => {
    const c = calcularProporcional(MENSAL_ILIMITADO, PROFISSIONAL, ciclo("2026-07-31"), new Date("2026-07-16"));
    expect(c.creditosAdicionais).toBe(0);
  });
});
