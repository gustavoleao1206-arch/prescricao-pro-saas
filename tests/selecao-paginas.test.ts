import { describe, it, expect } from "vitest";
import { selecionarPaginas, type PaginaTexto } from "../src/lib/legal/selecao-paginas";

describe("passe livre das páginas com evento-chave", () => {
  it("página obrigatória entra mesmo pontuando baixo na relevância", () => {
    // Regressão do IPTU municipal: a certidão curta da p.12 (intimação de
    // 17/12/2018) pontuava baixo e era descartada; sem vê-la, a IA errava o
    // marco da intercorrente. Página do detector não disputa: entra.
    const paginas = [
      { page: 1, text: "Petição inicial da execução fiscal. ".repeat(40) },
      ...Array.from({ length: 8 }, (_, i) => ({
        page: i + 2,
        text: "art. 40 da Lei 6.830 suspensão arquivamento penhora SISBAJUD parcelamento citação. ".repeat(30),
      })),
      // Grande o bastante para NÃO caber na sobra do orçamento sem prioridade
      // (o caso real: a certidão perdia a vaga para páginas "quentes" maiores).
      { page: 12, text: "Certidão: considera-se realizada a intimação no início do ato em 17/12/2018. ".repeat(28) },
    ];
    // Orçamento apertado o bastante para forçar descarte.
    const sem = selecionarPaginas(paginas, "prescricao_intercorrente", 6000);
    expect(sem.paginasEnviadas).not.toContain(12);

    const com = selecionarPaginas(paginas, "prescricao_intercorrente", 6000, new Set([12]));
    expect(com.paginasEnviadas).toContain(12);
  });
});

/**
 * Seleção das páginas que vão para a IA.
 *
 * MOTIVO: o orçamento de tokens não comporta uma cópia integral (181 mil
 * caracteres contra ~26 mil). Cortar pelos "primeiros N caracteres" entregava
 * a petição inicial e escondia as movimentações — num processo real a IA
 * respondeu "inconclusivo" sobre um feito cujo rito do art. 40 estava
 * documentado a partir da página 64.
 */

/** Processo sintético: capa, enchimento e páginas decisivas em posições altas. */
function processo(): PaginaTexto[] {
  const enchimento = "Documento anexo sem relevancia para a contagem do prazo. ".repeat(30);
  const pgs: PaginaTexto[] = [];
  for (let n = 1; n <= 100; n++) {
    if (n <= 4) pgs.push({ page: n, text: `CAPA E CDA - parte ${n}. ${enchimento}` });
    else if (n === 64) pgs.push({ page: n, text: `Suspensao do feito com base no art. 40 da Lei 6.830/1980. ${enchimento}` });
    else if (n === 77) pgs.push({ page: n, text: `Arquivamento provisorio dos autos sem baixa. ${enchimento}` });
    else if (n === 90) pgs.push({ page: n, text: `Recibo de parcelamento e penhora negativa. ${enchimento}` });
    else pgs.push({ page: n, text: enchimento });
  }
  return pgs;
}

describe("seleção de páginas por relevância", () => {
  const TETO = 8000; // força a seleção: o processo inteiro tem ~180 mil car.

  it("envia tudo quando o processo cabe no orçamento", () => {
    const curto: PaginaTexto[] = [{ page: 1, text: "abc" }, { page: 2, text: "def" }];
    const s = selecionarPaginas(curto, "prescricao_intercorrente", 10_000);
    expect(s.truncado).toBe(false);
    expect(s.paginasOmitidas).toBe(0);
    expect(s.paginasEnviadas).toEqual([1, 2]);
  });

  it("prefere as páginas decisivas às de enchimento", () => {
    const s = selecionarPaginas(processo(), "prescricao_intercorrente", TETO);
    expect(s.truncado).toBe(true);
    for (const decisiva of [64, 77, 90]) {
      expect(s.paginasEnviadas, `pagina ${decisiva} deveria entrar`).toContain(decisiva);
    }
  });

  it("inclui páginas iniciais, mas sem deixá-las consumir o orçamento", () => {
    const s = selecionarPaginas(processo(), "prescricao_intercorrente", TETO);
    // Pelo menos uma página de identificação entra...
    expect(s.paginasEnviadas.some((n) => n <= 4)).toBe(true);
    // ...e ainda sobra espaço para as decisivas. Sem a cota, as 4 primeiras
    // ocupavam 85% do teto e expulsavam o art. 40.
    expect(s.paginasEnviadas).toContain(64);
  });

  it("mantém a ordem cronológica no texto enviado", () => {
    const s = selecionarPaginas(processo(), "prescricao_intercorrente", TETO);
    const ordenado = [...s.paginasEnviadas].sort((a, b) => a - b);
    expect(s.paginasEnviadas).toEqual(ordenado);
  });

  it("respeita o teto de caracteres", () => {
    const s = selecionarPaginas(processo(), "prescricao_intercorrente", TETO);
    expect(s.texto.length).toBeLessThanOrEqual(TETO);
  });

  it("relata quantas páginas ficaram de fora", () => {
    const s = selecionarPaginas(processo(), "prescricao_intercorrente", TETO);
    expect(s.paginasEnviadas.length + s.paginasOmitidas).toBe(100);
    expect(s.paginasOmitidas).toBeGreaterThan(0);
  });

  it("a relevância muda conforme a matéria escolhida", () => {
    const pgs: PaginaTexto[] = [
      { page: 1, text: "capa" },
      { page: 2, text: "capa" },
      { page: 3, text: "capa" },
      { page: 4, text: "capa" },
      { page: 5, text: `Arquivamento e suspensao do art. 40 da LEF. ${"x".repeat(600)}` },
      { page: 6, text: `Pagamento antecipado por DARF e entrega de declaracao DCTF. ${"x".repeat(600)}` },
    ];
    const teto = 800;
    const inter = selecionarPaginas(pgs, "prescricao_intercorrente", teto);
    const deca = selecionarPaginas(pgs, "decadencia_tributaria", teto);
    expect(inter.paginasEnviadas).toContain(5);
    expect(deca.paginasEnviadas).toContain(6);
  });

  it("descarta páginas sem texto", () => {
    const pgs: PaginaTexto[] = [{ page: 1, text: "conteudo" }, { page: 2, text: "   " }, { page: 3, text: "" }];
    const s = selecionarPaginas(pgs, "prescricao_ordinaria", 10_000);
    expect(s.paginasEnviadas).toEqual([1]);
  });

  it("sem matéria definida ainda respeita o teto e as páginas iniciais", () => {
    const s = selecionarPaginas(processo(), null, TETO);
    expect(s.texto.length).toBeLessThanOrEqual(TETO);
    expect(s.paginasEnviadas).toContain(1);
  });

  it("rotula cada página para a IA poder citar a fonte", () => {
    const s = selecionarPaginas(processo(), "prescricao_intercorrente", TETO);
    expect(s.texto).toMatch(/--- p\.64 ---/);
  });
});
