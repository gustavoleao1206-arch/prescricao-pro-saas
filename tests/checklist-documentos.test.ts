import { describe, it, expect } from "vitest";
import {
  montarChecklist,
  checklistEmTexto,
  checklistDeFacts,
  DOCUMENTOS_POR_MATERIA,
} from "../src/lib/legal/checklist-documentos";

/**
 * Checklist determinístico de documentos.
 *
 * É ele que decide o aviso "a conclusão poderá ser limitada" ANTES da análise
 * (e da cobrança do crédito) — por isso a detecção não pode depender da IA nem
 * variar entre execuções. Estes testes travam os padrões contra textos
 * realistas de execução fiscal.
 */

const TEXTO_INTERCORRENTE_COMPLETO = `
EXECUÇÃO FISCAL. Certidão de Dívida Ativa nº 123. Petição inicial distribuída em 10/03/2010.
Despacho: Cite-se o executado. Mandado de citação expedido. Aviso de Recebimento juntado.
Certidão do Oficial de Justiça: não localizado o devedor.
Decisão: suspendo o curso da execução, na forma do art. 40 da Lei 6.830/80. Intime-se a Fazenda.
Arquivem-se os autos provisoriamente. Movimentações do processo em anexo.
A Fazenda Nacional requer pesquisa SISBAJUD. Resultado RENAJUD negativo. INFOJUD sem bens.
SERASAJUD incluído. Penhora não realizada. Não foram localizados bens penhoráveis.
`;

const TEXTO_SO_CAPA = `
Documento de identificação. Foto. Página em branco. Assinatura digital.
`;

describe("prescrição intercorrente", () => {
  it("localiza os documentos num processo completo", () => {
    const c = montarChecklist("prescricao_intercorrente", TEXTO_INTERCORRENTE_COMPLETO);
    const porId = new Map(c.itens.map((i) => [i.id, i.encontrado]));

    expect(porId.get("cda")).toBe(true);
    expect(porId.get("peticao-inicial")).toBe(true);
    expect(porId.get("despacho-citatorio")).toBe(true);
    // Citação agrupada por modalidade: mandado é UMA das formas de encontrá-la.
    expect(porId.get("citacao")).toBe(true);
    expect(porId.get("ar")).toBe(true);
    expect(porId.get("suspensao-art40")).toBe(true);
    expect(porId.get("ciencia-fazenda")).toBe(true);
    expect(porId.get("resultado-pesquisa-patrimonial")).toBe(true);
    expect(porId.get("arquivamento")).toBe(true);
    expect(porId.get("sisbajud")).toBe(true);
    expect(porId.get("renajud")).toBe(true);
    expect(porId.get("infojud")).toBe(true);
    expect(porId.get("serasajud")).toBe(true);
    expect(c.limitada).toBe(false);
    expect(c.aviso).toBeNull();
  });

  it("sem documento essencial, avisa com a mensagem exigida pela especificação", () => {
    const c = montarChecklist("prescricao_intercorrente", TEXTO_SO_CAPA);
    expect(c.limitada).toBe(true);
    expect(c.essenciaisAusentes.length).toBeGreaterThan(0);
    // Texto literal exigido: "Documento importante não localizado para análise da prescrição intercorrente."
    expect(c.aviso).toMatch(/Documento importante não localizado para análise da prescrição intercorrente/);
    expect(c.aviso).toMatch(/conclusão poderá ser limitada/i);
  });

  it("a sigla AR não casa com a palavra 'ar' em minúsculas", () => {
    // Regressão em potencial: com case-insensitive, "o ar condicionado" marcaria
    // o Aviso de Recebimento como presente em qualquer texto.
    const c = montarChecklist("prescricao_intercorrente", "o ar condicionado da sala parou");
    expect(c.itens.find((i) => i.id === "ar")?.encontrado).toBe(false);

    const c2 = montarChecklist("prescricao_intercorrente", "juntado o AR dos Correios");
    expect(c2.itens.find((i) => i.id === "ar")?.encontrado).toBe(true);
  });
});

describe("prescrição ordinária", () => {
  it("detecta parcelamento, confissão e extrato, que mudam a contagem do prazo", () => {
    const texto = `
      CDA anexa. Petição inicial. Cite-se. Certidão de citação positiva.
      O executado aderiu ao parcelamento REFIS. Termo de confissão de dívida assinado.
      Pagamento parcial via DARF. Extrato da dívida ativa atualizado. Inscrição em dívida ativa nº 9.
    `;
    const c = montarChecklist("prescricao_ordinaria", texto);
    const porId = new Map(c.itens.map((i) => [i.id, i.encontrado]));
    expect(porId.get("parcelamento")).toBe(true);
    expect(porId.get("confissao")).toBe(true);
    expect(porId.get("pagamento-parcial")).toBe(true);
    expect(porId.get("extrato-divida")).toBe(true);
    expect(porId.get("citacao")).toBe(true);
    expect(c.limitada).toBe(false);
  });

  it("a mensagem de ausência cita a matéria correta", () => {
    const c = montarChecklist("prescricao_ordinaria", TEXTO_SO_CAPA);
    expect(c.aviso).toMatch(/para análise da prescrição ordinária/);
  });
});

describe("decadência", () => {
  it("detecta o processo administrativo e o lançamento", () => {
    const texto = `
      Auto de Infração lavrado em 2015. Notificação do lançamento entregue.
      Processo Administrativo Fiscal nº 10.000. Impugnação apresentada.
      Recurso voluntário ao CARF. Decisão administrativa definitiva.
      Constituição definitiva do crédito. CDA emitida. Demonstrativo de débito.
    `;
    const c = montarChecklist("decadencia_tributaria", texto);
    const porId = new Map(c.itens.map((i) => [i.id, i.encontrado]));
    expect(porId.get("auto-infracao")).toBe(true);
    expect(porId.get("notificacao-lancamento")).toBe(true);
    expect(porId.get("paf")).toBe(true);
    expect(porId.get("defesa-administrativa")).toBe(true);
    expect(porId.get("recursos-administrativos")).toBe(true);
    expect(porId.get("decisao-administrativa")).toBe(true);
    expect(porId.get("constituicao-definitiva")).toBe(true);
    expect(c.limitada).toBe(false);
  });

  it("execução sem auto de infração nem notificação fica limitada", () => {
    // Caso comum: cliente envia só a execução fiscal e pede decadência. Sem o
    // processo administrativo não há como fixar o marco do lançamento.
    const c = montarChecklist("decadencia_tributaria", "CDA nº 1. Cite-se. Lançamento mencionado.");
    expect(c.limitada).toBe(true);
    expect(c.aviso).toMatch(/para análise da decadência/);
  });
});

describe("formato e persistência", () => {
  it("o texto do checklist usa ✓/✗ como na especificação", () => {
    const c = montarChecklist("prescricao_intercorrente", TEXTO_INTERCORRENTE_COMPLETO);
    const t = checklistEmTexto(c);
    expect(t).toMatch(/✓ CDA/);
    expect(t).toMatch(/de \d+ localizados/);
    // Documento não encontrado aparece com ✗.
    const c2 = montarChecklist("prescricao_intercorrente", "CDA. Cite-se. suspensão do processo art. 40 LEF");
    expect(checklistEmTexto(c2)).toMatch(/✗ /);
  });

  it("recupera o checklist gravado em facts e rejeita formato inválido", () => {
    const c = montarChecklist("prescricao_ordinaria", "CDA");
    expect(checklistDeFacts({ checklistDocumentos: c })).not.toBeNull();
    expect(checklistDeFacts({ checklistDocumentos: { qualquer: 1 } })).toBeNull();
    expect(checklistDeFacts(null)).toBeNull();
    expect(checklistDeFacts({})).toBeNull();
  });

  it("cada matéria tem a própria lista, com os itens da especificação", () => {
    const rotulos = (m: keyof typeof DOCUMENTOS_POR_MATERIA) =>
      DOCUMENTOS_POR_MATERIA[m].map((d) => d.rotulo).join(" | ");
    expect(rotulos("prescricao_intercorrente")).toMatch(/SISBAJUD.*RENAJUD.*INFOJUD.*SERASAJUD/);
    expect(rotulos("prescricao_ordinaria")).toMatch(/Parcelamentos.*Confissão/);
    expect(rotulos("decadencia_tributaria")).toMatch(/Auto de Infração.*Processo Administrativo/);
  });
});
