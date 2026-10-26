import { describe, it, expect } from "vitest";
import { detectarEventosChave, formatarEventosChave, candidatosMarcoVencidos } from "../src/lib/legal/deteccao-eventos";

/**
 * Detecção determinística de eventos-chave.
 *
 * MOTIVO (caso real): a IA omitiu da linha do tempo a intimação de 17/12/2018
 * e a certidão de inércia de 20/05/2021 do IPTU municipal — os fatos que
 * definem o marco da intercorrente. A varredura por padrão garante que esses
 * eventos cheguem ao prompt com página e data, e a IA fica proibida de
 * simplesmente ignorá-los.
 */

// Texto no formato das fls. 10-13 do caso que motivou o teste (número e comarca omitidos).
const PAGINAS_IPTU = [
  { page: 10, text: "Vistos. Diga a Fazenda em termos de prosseguimento. No mais, concedo o prazo de 120 (cento e vinte) dias para manifestação. Intime-se. Comarca de Exemplo, 03/12/2018." },
  { page: 12, text: "CERTIDÃO. Certifico que em 13/12/2018 transcorreu o prazo de leitura no portal eletrônico. Considera-se realizada a intimação automática no início do ato em 17/12/2018." },
  { page: 13, text: "Certifico e dou fé ter decorrido o prazo sem manifestação da Fazenda. Em 20/05/2021." },
  { page: 16, text: "Ante o exposto, determino a suspensão do curso da execução, na forma do art. 40, §1º, da Lei 6.830/80. Int. 22/06/2023." },
];

describe("detecção dos eventos que a IA omitiu no caso real", () => {
  const eventos = detectarEventosChave(PAGINAS_IPTU);
  const tipos = new Map(eventos.map((e) => [e.tipo, e]));

  it("encontra a intimação para prosseguimento com a data na página", () => {
    const e = tipos.get("intimacao-prosseguimento");
    expect(e).toBeDefined();
    expect(e!.pagina).toBe(10);
    expect(e!.datas).toContain("03/12/2018");
  });

  it("encontra a certidão com o INÍCIO da intimação (17/12/2018)", () => {
    const e = tipos.get("inicio-intimacao");
    expect(e).toBeDefined();
    expect(e!.datas).toContain("17/12/2018");
  });

  it("encontra a certidão de inércia de 20/05/2021", () => {
    const e = tipos.get("inercia-certificada");
    expect(e).toBeDefined();
    expect(e!.pagina).toBe(13);
    expect(e!.datas).toContain("20/05/2021");
  });

  it("encontra a suspensão do art. 40", () => {
    const e = tipos.get("suspensao-art40");
    expect(e).toBeDefined();
    expect(e!.datas).toContain("22/06/2023");
  });
});

describe("outros padrões estruturais", () => {
  it("detecta citação por carta com AR e constrição efetiva", () => {
    const eventos = detectarEventosChave([
      { page: 8, text: "Carta de citação expedida ao executado em 30/08/2017." },
      { page: 9, text: "Aviso de Recebimento assinado pelo recebedor em 25/10/2017." },
      { page: 18, text: "Termo de penhora lavrado. Bloqueio efetivado no valor de R$ 12.000,00 em 10/02/2020." },
    ]);
    const tipos = eventos.map((e) => e.tipo);
    expect(tipos).toContain("citacao");
    expect(tipos).toContain("constricao");
  });

  it("detecta parcelamento e pagamento (o que interrompe a contagem)", () => {
    const eventos = detectarEventosChave([
      { page: 77, text: "Requerimento de adesão ao parcelamento da Lei 11.941/2009. DARF recolhida em 15/09/2009." },
    ]);
    expect(eventos.map((e) => e.tipo)).toContain("parcelamento-pagamento");
  });

  it("página em branco ou curta não gera evento", () => {
    expect(detectarEventosChave([{ page: 1, text: "1/21" }, { page: 2, text: "" }])).toEqual([]);
  });
});

describe("candidatos a marco vencido, direto do detector", () => {
  const HOJE = new Date(Date.UTC(2026, 6, 24, 12)); // 24/07/2026

  it("no caso real, aponta 17/12/2018 (início da intimação) com consumação em 2024", () => {
    // Independe da linha do tempo da IA: o modelo omitia esses eventos em
    // rodadas alternadas e o confronto nunca disparava.
    const candidatos = candidatosMarcoVencidos(detectarEventosChave(PAGINAS_IPTU), "prescricao_intercorrente", HOJE);
    const datas = candidatos.map((c) => c.data);
    expect(datas).toContain("17/12/2018");
    const c2018 = candidatos.find((c) => c.data === "17/12/2018")!;
    expect(c2018.consumacaoCalculada).toBe("17/12/2024");
    // A certidão usa a data MAIS RECENTE da página (início do ato), não a da lavratura.
    expect(datas).not.toContain("13/12/2018");
    // 2021+6=2027 e 2023+6=2029 são futuros: não entram.
    expect(datas.every((d) => !d.endsWith("2021") && !d.endsWith("2023"))).toBe(true);
  });

  it("obstativo detectado depois do candidato o elimina", () => {
    const paginas = [
      ...PAGINAS_IPTU,
      { page: 19, text: "Termo de penhora lavrado. Bloqueio efetivado no valor de R$ 10.000,00 em 05/03/2020." },
    ];
    const candidatos = candidatosMarcoVencidos(detectarEventosChave(paginas), "prescricao_intercorrente", HOJE);
    expect(candidatos.map((c) => c.data)).not.toContain("17/12/2018");
  });
});

describe("bloco injetado no prompt", () => {
  it("é imperativo: incorporar ou refutar, nunca omitir", () => {
    const bloco = formatarEventosChave(detectarEventosChave(PAGINAS_IPTU));
    expect(bloco).toMatch(/EVENTOS-CHAVE DETECTADOS PELO SISTEMA/);
    expect(bloco).toMatch(/PROIBIDO simplesmente omitir/);
    expect(bloco).toContain("p.13");
    expect(bloco).toContain("20/05/2021");
  });

  it("sem eventos, não injeta nada", () => {
    expect(formatarEventosChave([])).toBe("");
  });
});
