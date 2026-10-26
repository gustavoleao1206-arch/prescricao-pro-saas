import { describe, it, expect } from "vitest";
import { renovacaoDe } from "../src/lib/renovacao";
import type { Subscription } from "@prisma/client";

/**
 * O que a tela diz sobre a continuidade da assinatura.
 *
 * ── O defeito ─────────────────────────────────────────────────────────────────
 * O painel — a PRIMEIRA tela que o cliente vê — exibia um cartão fixo "Próxima
 * renovação", com a data caindo para o fim do período quando não havia renovação nenhuma.
 * Duas promessas falsas saíam daí:
 *
 *  - PIX é cobrança ÚNICA (não existe mandato de débito em PIX, então o provedor não tem
 *    como cobrar de novo). O cliente lia uma data rotulada como renovação, não fazia nada
 *    e descobria que não renovou quando o acesso parou.
 *  - Quem CANCELOU passou a ter o campo de renovação nulo também — é o que o
 *    cancelamento grava. Ele lia "Próxima renovação: 14/08" no dia seguinte a pedir para
 *    parar de ser cobrado.
 *
 * São TRÊS estados, e é isso que estes testes travam. "Renova" e "não renova" não bastam:
 * ciclo único nunca prometeu renovar (nada de errado, e o texto convida a contratar de
 * novo); contrato encerrado a pedido renovava e deixou de renovar (o texto tem de
 * confirmar que não haverá novas cobranças). Chamar os dois de "pagamento único" mentiria
 * para o segundo.
 */

const fim = new Date("2026-09-04T12:00:00.000Z");
const proxima = new Date("2026-09-04T12:00:00.000Z");

function sub(dados: Partial<Subscription>): Subscription {
  return {
    status: "ATIVA",
    nextRenewalAt: null,
    currentPeriodEnd: fim,
    canceledByRequestAt: null,
    ...dados,
  } as Subscription;
}

describe("assinatura que renova", () => {
  it("diz 'Próxima cobrança' e usa a data da renovação", () => {
    const r = renovacaoDe(sub({ nextRenewalAt: proxima }));
    expect(r.modo).toBe("renova");
    expect(r.rotuloDaData).toBe("Próxima cobrança");
    expect(r.data).toEqual(proxima);
    expect(r.temProximoCiclo).toBe(true);
    expect(r.formaDeCobranca).toContain("renovação automática");
  });

  it("em atraso, a data que importa é até quando o acesso resiste", () => {
    // Dentro da tolerância o cliente precisa saber o prazo que tem para regularizar,
    // não quando sai a próxima cobrança.
    const r = renovacaoDe(sub({ nextRenewalAt: proxima, status: "INADIMPLENTE" }), { emTolerancia: true });
    expect(r.rotuloDaData).toBe("Acesso até");
    expect(r.formaDeCobranca).toContain("atraso");
    // Continua sendo contrato que renova: regularizado, a cobrança volta.
    expect(r.temProximoCiclo).toBe(true);
  });
});

describe("cobrança única (PIX)", () => {
  it("NÃO promete renovação", () => {
    const r = renovacaoDe(sub({ nextRenewalAt: null }));
    expect(r.modo).toBe("ciclo-unico");
    expect(r.rotuloDaData).toBe("Acesso até");
    expect(r.rotuloDaData).not.toContain("renovação");
    expect(r.temProximoCiclo).toBe(false);
    expect(r.formaDeCobranca).toContain("pagamento único");
  });

  it("a data exibida é o fim do período contratado", () => {
    expect(renovacaoDe(sub({ nextRenewalAt: null })).data).toEqual(fim);
  });
});

describe("assinatura encerrando", () => {
  /**
   * O caso que a versão anterior errava: o cancelamento zera a data de renovação, então a
   * regra "sem data de renovação = pagamento único" classificava quem acabou de cancelar
   * uma recorrência no cartão como se ele nunca tivesse assinado uma.
   */
  it("cancelada a pedido não é 'pagamento único' — é 'não haverá novas cobranças'", () => {
    const r = renovacaoDe(sub({ status: "CANCELADA", canceledByRequestAt: new Date("2026-08-04T10:00:00.000Z") }));
    expect(r.modo).toBe("encerrando");
    expect(r.rotuloDaData).toBe("Acesso até");
    expect(r.formaDeCobranca).toContain("não haverá novas cobranças");
    expect(r.formaDeCobranca).not.toContain("pagamento único");
    expect(r.temProximoCiclo).toBe(false);
  });

  it("o pedido de parada manda mesmo quando o status ainda não mudou", () => {
    // A ordem das escritas não pode fazer a tela prometer cobrança a quem pediu parada.
    const r = renovacaoDe(sub({ status: "ATIVA", nextRenewalAt: proxima, canceledByRequestAt: new Date() }));
    expect(r.modo).toBe("encerrando");
    expect(r.temProximoCiclo).toBe(false);
  });

  it("estornada e vencida também estão encerrando", () => {
    expect(renovacaoDe(sub({ status: "ESTORNADA" })).modo).toBe("encerrando");
    expect(renovacaoDe(sub({ status: "VENCIDA" })).modo).toBe("encerrando");
  });

  it("suspensa NÃO está encerrando: é bloqueio, e a cobrança segue", () => {
    // Suspender bloqueia o acesso e não interrompe a recorrência — dizer "não haverá
    // novas cobranças" seria a mentira oposta.
    const r = renovacaoDe(sub({ status: "SUSPENSA", nextRenewalAt: proxima }));
    expect(r.modo).toBe("renova");
  });
});

describe("sem assinatura", () => {
  it("não inventa data nem promessa", () => {
    const r = renovacaoDe(null);
    expect(r.data).toBeNull();
    expect(r.temProximoCiclo).toBe(false);
    expect(r.rotuloDaData).not.toContain("renovação");
  });
});
