import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  custoEmCreditos,
  saldoDe,
  temSaldo,
  chaveDoCiclo,
  consumirCreditos,
  estornarCreditos,
  liberarCreditosDoCiclo,
  creditarPacote,
  expirarCreditosAdicionais,
  ajustarCreditosAdmin,
  SaldoInsuficienteError,
  MAX_PAGINAS_AUTOMATICO,
} from "../src/lib/credits";
import type { Subscription } from "@prisma/client";

/**
 * Motor de créditos.
 *
 * É a parte do sistema em que um erro custa dinheiro de verdade: crédito
 * liberado em dobro é prejuízo, crédito consumido em dobro é cliente lesado.
 * Por isso estes testes vão ao banco de verdade, em vez de simular o Prisma —
 * a idempotência e a concorrência que precisam ser provadas vivem na transação,
 * não no TypeScript.
 *
 * Cada teste monta o próprio plano, organização e assinatura, com prefixo
 * `test-credito-`, e apaga tudo ao final. Nenhum dado existente é tocado.
 */

const prisma = new PrismaClient();
const PREFIXO = "test-credito";

let planoId = "";
let planoAnualId = "";
let orgId = "";
let userId = "";
let subId = "";

async function limpar() {
  const orgs = await prisma.organization.findMany({
    where: { name: { startsWith: PREFIXO } },
    select: { id: true },
  });
  const ids = orgs.map((o) => o.id);
  if (ids.length) {
    // Ordem importa: a razão referencia análises e assinaturas.
    const subs = await prisma.subscription.findMany({ where: { organizationId: { in: ids } }, select: { id: true } });
    await prisma.creditLedger.deleteMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } } });
    await prisma.aiUsageRecord.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.consumptionRecord.deleteMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } } });
    await prisma.analysis.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.subscription.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.user.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.organization.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIXO } } });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

/** Cria uma assinatura limpa com a cota pedida. */
async function novaAssinatura(cota: number, extra = 0, anual = false): Promise<string> {
  const sub = await prisma.subscription.create({
    data: {
      organizationId: orgId,
      planId: anual ? planoAnualId : planoId,
      status: "ATIVA",
      provider: "MANUAL",
      amountCents: anual ? 119900 : 11990,
      analysesQuota: cota,
      analysesUsed: 0,
      extraAnalyses: extra,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  return sub.id;
}

async function novaAnalise(titulo = "Processo de teste"): Promise<string> {
  const a = await prisma.analysis.create({
    data: { organizationId: orgId, ownerId: userId, title: `${PREFIXO} — ${titulo}`, status: "RASCUNHO" },
  });
  return a.id;
}

async function lerSub(id: string) {
  return prisma.subscription.findUniqueOrThrow({ where: { id } });
}

beforeAll(async () => {
  await limpar();
  const plano = await prisma.plan.create({
    data: { slug: `${PREFIXO}-profissional`, name: "Teste Profissional", priceCents: 11990, period: "MENSAL", monthlyAnalyses: 8, maxUsers: 1 },
  });
  planoId = plano.id;
  const anual = await prisma.plan.create({
    data: { slug: `${PREFIXO}-profissional-anual`, name: "Teste Profissional Anual", priceCents: 119900, period: "ANUAL", monthlyAnalyses: 8, maxUsers: 1 },
  });
  planoAnualId = anual.id;
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org` } });
  orgId = org.id;
  const user = await prisma.user.create({
    data: { email: `${PREFIXO}@exemplo.local`, name: "Cliente de Teste", organizationId: orgId, status: "ATIVO" },
  });
  userId = user.id;
});

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

beforeEach(async () => {
  subId = await novaAssinatura(8);
});

// ---------------------------------------------------------------------------

describe("custo de uma análise, por tamanho do processo", () => {
  const mb = (n: number) => n * 1024 * 1024;

  it("cobra 1, 2 e 4 créditos conforme a faixa de páginas", () => {
    expect(custoEmCreditos(1, mb(1)).creditos).toBe(1);
    expect(custoEmCreditos(250, mb(10)).creditos).toBe(1);
    expect(custoEmCreditos(251, mb(10)).creditos).toBe(2);
    expect(custoEmCreditos(500, mb(10)).creditos).toBe(2);
    expect(custoEmCreditos(501, mb(10)).creditos).toBe(4);
    expect(custoEmCreditos(1000, mb(10)).creditos).toBe(4);
  });

  it("recusa o processamento automático acima de 1.000 páginas e orienta análise especial", () => {
    const r = custoEmCreditos(MAX_PAGINAS_AUTOMATICO + 1, mb(10));
    expect(r.bloqueado).toBe(true);
    expect(r.motivo).toMatch(/análise especial/i);
  });

  it("o limite de MB acompanha a faixa, em vez de recusar processo grande por tamanho", () => {
    // 400 páginas com 45 MB cabe na faixa de 60 MB…
    expect(custoEmCreditos(400, mb(45)).bloqueado).toBe(false);
    // …mas as mesmas 45 MB em 100 páginas estouram o limite de 30 MB da faixa 1.
    expect(custoEmCreditos(100, mb(45)).bloqueado).toBe(true);
  });
});

describe("leitura de saldo", () => {
  const base = { analysesQuota: 8, analysesUsed: 3, extraAnalyses: 2 } as Subscription;

  it("separa a bolsa mensal da adicional e soma o total", () => {
    const s = saldoDe(base);
    expect(s.saldoMensal).toBe(5);
    expect(s.saldoAdicional).toBe(2);
    expect(s.total).toBe(7);
  });

  it("sem assinatura, saldo zero e nada é permitido", () => {
    expect(saldoDe(null).total).toBe(0);
    expect(temSaldo(null, 1)).toBe(false);
  });

  it("compara o saldo com o custo da análise, não com o número de análises", () => {
    const s = { analysesQuota: 3, analysesUsed: 1, extraAnalyses: 0 } as Subscription;
    expect(temSaldo(s, 2)).toBe(true);
    expect(temSaldo(s, 4)).toBe(false); // processo grande não cabe no saldo
  });
});

describe("consumo", () => {
  it("debita da bolsa mensal e registra saldo anterior e posterior", async () => {
    const analiseId = await novaAnalise();
    const r = await consumirCreditos(subId, analiseId, 2);

    expect(r.consumidos).toBe(2);
    expect(r.daMensal).toBe(2);
    expect(r.saldoRestante).toBe(6);
    expect((await lerSub(subId)).analysesUsed).toBe(2);

    const linha = await prisma.creditLedger.findFirstOrThrow({ where: { analysisId: analiseId, kind: "CONSUMO" } });
    expect(linha.balanceBefore).toBe(8);
    expect(linha.balanceAfter).toBe(6);
    expect(linha.quantity).toBe(-2);
  });

  it("gasta o crédito mensal antes do adicional, porque o mensal expira antes", async () => {
    const sub2 = await novaAssinatura(2, 5);
    const analiseId = await novaAnalise();
    const r = await consumirCreditos(sub2, analiseId, 4);

    expect(r.daMensal).toBe(2);
    expect(r.doAdicional).toBe(2);
    const s = await lerSub(sub2);
    expect(s.analysesUsed).toBe(2);
    expect(s.extraAnalyses).toBe(3);
  });

  it("cobrar a mesma análise duas vezes não debita de novo", async () => {
    const analiseId = await novaAnalise();
    await consumirCreditos(subId, analiseId, 2);
    const repetido = await consumirCreditos(subId, analiseId, 2);

    expect(repetido.jaConsumido).toBe(true);
    expect((await lerSub(subId)).analysesUsed).toBe(2);
  });

  /**
   * ── Reprocessamento que muda de faixa ────────────────────────────────────────
   *
   * "Análise já cobrada não cobra de novo" é regra do produto, e é justa: reprocessar
   * depois de uma correção técnica não deve custar duas vezes. Mas ela era aplicada sem
   * olhar O QUE está sendo reprocessado.
   *
   * O caminho que saía de graça: 200 páginas (1 crédito), processa, ACRESCENTA 700
   * páginas e reprocessa. O processo passa a custar 4 créditos pela tabela de faixas e
   * saía por 1. Dava para analisar mil páginas por um crédito, quantas vezes quisesse.
   */
  it("documentos acrescentados cobram a DIFERENÇA de faixa, não o custo cheio", async () => {
    const analiseId = await novaAnalise();
    await consumirCreditos(subId, analiseId, 1);
    expect((await lerSub(subId)).analysesUsed).toBe(1);

    // Agora o processo tem 900 páginas: 4 créditos pela faixa.
    const r = await consumirCreditos(subId, analiseId, 4);

    expect(r.jaConsumido).toBe(false);
    expect(r.complementoCobrado).toBe(3);
    // O cliente nunca paga duas vezes pelo que já pagou: 1 + 3, não 1 + 4.
    expect((await lerSub(subId)).analysesUsed).toBe(4);
    expect(r.consumidos).toBe(4);
  });

  it("reprocessar na MESMA faixa continua gratuito", async () => {
    const analiseId = await novaAnalise();
    await consumirCreditos(subId, analiseId, 2);

    const primeiro = await consumirCreditos(subId, analiseId, 2);
    const segundo = await consumirCreditos(subId, analiseId, 2);

    expect(primeiro.jaConsumido).toBe(true);
    expect(segundo.jaConsumido).toBe(true);
    expect((await lerSub(subId)).analysesUsed).toBe(2);
  });

  it("reprocessar de novo depois do complemento não cobra outra vez", async () => {
    const analiseId = await novaAnalise();
    await consumirCreditos(subId, analiseId, 1);
    await consumirCreditos(subId, analiseId, 4);

    // Mesma faixa: nada a complementar. A chave do complemento é pelo TOTAL atingido.
    const terceiro = await consumirCreditos(subId, analiseId, 4);

    expect(terceiro.jaConsumido).toBe(true);
    expect((await lerSub(subId)).analysesUsed).toBe(4);
  });

  it("faixa que DIMINUI não devolve crédito nem cobra de novo", async () => {
    const analiseId = await novaAnalise();
    await consumirCreditos(subId, analiseId, 4);

    // Documento removido: o processo agora custaria 1. O já pago não volta — o serviço
    // da faixa maior foi entregue —, e nada é cobrado.
    const r = await consumirCreditos(subId, analiseId, 1);

    expect(r.jaConsumido).toBe(true);
    expect((await lerSub(subId)).analysesUsed).toBe(4);
  });

  it("sem saldo para a diferença, recusa e não entrega a faixa maior", async () => {
    const sub2 = await novaAssinatura(2);
    const analiseId = await novaAnalise();
    await consumirCreditos(sub2, analiseId, 1);

    await expect(consumirCreditos(sub2, analiseId, 4)).rejects.toBeInstanceOf(SaldoInsuficienteError);
    // O que já havia sido cobrado permanece; a diferença não foi debitada.
    expect((await lerSub(sub2)).analysesUsed).toBe(1);
  });

  it("recusa quando o saldo não cobre o custo, sem debitar nada", async () => {
    const sub2 = await novaAssinatura(1);
    const analiseId = await novaAnalise();

    await expect(consumirCreditos(sub2, analiseId, 4)).rejects.toBeInstanceOf(SaldoInsuficienteError);
    const s = await lerSub(sub2);
    expect(s.analysesUsed).toBe(0);
    expect(await prisma.creditLedger.count({ where: { subscriptionId: sub2 } })).toBe(0);
  });

  it("duas análises simultâneas não gastam o mesmo último crédito", async () => {
    const sub2 = await novaAssinatura(1);
    const [a, b] = [await novaAnalise("A"), await novaAnalise("B")];

    const resultados = await Promise.allSettled([
      consumirCreditos(sub2, a, 1),
      consumirCreditos(sub2, b, 1),
    ]);
    const aceitos = resultados.filter((r) => r.status === "fulfilled").length;

    // Uma passa, a outra é recusada por saldo ou por concorrência. O que não
    // pode acontecer é o saldo ficar negativo.
    expect(aceitos).toBe(1);
    expect((await lerSub(sub2)).analysesUsed).toBe(1);
  });
});

describe("estorno por erro técnico", () => {
  it("devolve o crédito e zera a cobrança da análise", async () => {
    const analiseId = await novaAnalise();
    await consumirCreditos(subId, analiseId, 2);

    const r = await estornarCreditos(subId, analiseId, "falha ao chamar a IA");
    expect(r.estornados).toBe(2);
    expect((await lerSub(subId)).analysesUsed).toBe(0);
    expect((await prisma.analysis.findUniqueOrThrow({ where: { id: analiseId } })).creditsCharged).toBe(0);
  });

  it("devolve cada crédito à bolsa de onde saiu", async () => {
    // Regressão: devolver tudo como crédito mensal faria o cliente perder o
    // crédito adicional que comprou, porque o mensal expira no fim do ciclo.
    const sub2 = await novaAssinatura(2, 5);
    const analiseId = await novaAnalise();
    await consumirCreditos(sub2, analiseId, 4); // 2 mensais + 2 adicionais

    await estornarCreditos(sub2, analiseId, "erro de processamento");

    const s = await lerSub(sub2);
    expect(s.analysesUsed).toBe(0);
    expect(s.extraAnalyses).toBe(5);
  });

  /**
   * ── Estorno DEPOIS da virada de ciclo ────────────────────────────────────────
   *
   * Devolver à bolsa mensal significa desfazer consumo: `analysesUsed - devolvido`. Isso
   * pressupõe que o consumo ainda está lá — e depois da virada do ciclo não está. A
   * liberação do ciclo novo zera `analysesUsed`, então `Math.max(0, 0 - 1)` continuava
   * zero: o EXTRATO registrava a devolução e o SALDO não mudava em nada. Neste módulo o
   * extrato é a fonte da verdade, e ele estava prometendo o que o contador não entregava.
   *
   * Acontece sempre que a análise falha perto da virada: o processamento morre, a
   * varredura de manutenção estorna na madrugada seguinte, e o ciclo já virou.
   */
  it("depois da virada do ciclo, o crédito volta MESMO — como adicional", async () => {
    const analiseId = await novaAnalise("virada");
    await consumirCreditos(subId, analiseId, 2);

    // O ciclo virou: consumo zerado, cota nova. Nada a "desfazer" na bolsa mensal.
    await prisma.subscription.update({ where: { id: subId }, data: { analysesUsed: 0 } });
    const antes = await lerSub(subId);
    expect(antes.extraAnalyses).toBe(0);

    const r = await estornarCreditos(subId, analiseId, "erro técnico após a virada");

    expect(r.estornados).toBe(2);
    const depois = await lerSub(subId);
    // O que o extrato promete, o saldo entrega: dois créditos utilizáveis.
    expect(saldoDe(depois).total).toBe(saldoDe(antes).total + 2);
    // Na bolsa que não expira com o ciclo — o ciclo do consumo já acabou.
    expect(depois.extraAnalyses).toBe(2);
    expect(depois.analysesUsed).toBe(0);
  });

  it("extrato e saldo não divergem: o lançamento diz a bolsa que recebeu", async () => {
    const analiseId = await novaAnalise("virada-extrato");
    await consumirCreditos(subId, analiseId, 1);
    await prisma.subscription.update({ where: { id: subId }, data: { analysesUsed: 0 } });

    await estornarCreditos(subId, analiseId, "erro técnico");

    const lancamento = await prisma.creditLedger.findFirstOrThrow({
      where: { subscriptionId: subId, analysisId: analiseId, kind: "ESTORNO" },
    });
    expect(lancamento.bucket).toBe("ADICIONAL");
    // O cliente veria "crédito adicional" sem ter comprado nenhum: a linha explica.
    expect(lancamento.description).toContain("ciclo do consumo já havia virado");
    expect(lancamento.balanceAfter - lancamento.balanceBefore).toBe(1);
  });

  it("virada PARCIAL: a bolsa mensal absorve o que pode, o resto vai para a adicional", async () => {
    const analiseId = await novaAnalise("virada-parcial");
    await consumirCreditos(subId, analiseId, 4);

    // Estado intermediário: sobrou 1 de consumo mensal para desfazer.
    await prisma.subscription.update({ where: { id: subId }, data: { analysesUsed: 1 } });

    const r = await estornarCreditos(subId, analiseId, "erro técnico");

    expect(r.estornados).toBe(4);
    const depois = await lerSub(subId);
    expect(depois.analysesUsed).toBe(0);
    // 1 absorvido pela mensal, 3 para a adicional. Nada se perde no caminho.
    expect(depois.extraAnalyses).toBe(3);
  });

  it("análise estornada e rodada de novo é COBRADA de novo", async () => {
    /**
     * O defeito que dava serviço de graça, para sempre.
     *
     * A idempotência do consumo era "existe CONSUMO desta análise? então já foi
     * cobrada", e ignorava o estorno. `estornarCreditos` acrescenta a linha de ESTORNO
     * e DEIXA a de CONSUMO — o extrato precisa mostrar as duas. Então: a análise falha,
     * é estornada, o cliente roda de novo, e a cobrança era ignorada. Estorno por erro
     * técnico virou um jeito de não pagar.
     */
    const analiseId = await novaAnalise("estorno e reexecucao");
    const primeira = await consumirCreditos(subId, analiseId, 2);
    expect(primeira.consumidos).toBe(2);
    expect((await lerSub(subId)).analysesUsed).toBe(2);

    // Falhou: estorno automático devolve.
    const devolucao = await estornarCreditos(subId, analiseId, "erro técnico");
    expect(devolucao.estornados).toBe(2);
    expect((await lerSub(subId)).analysesUsed).toBe(0);

    // Roda de novo: TEM de cobrar.
    const segunda = await consumirCreditos(subId, analiseId, 2);
    expect(segunda.jaConsumido, "a segunda execução saiu de graça").toBe(false);
    expect(segunda.consumidos).toBe(2);
    expect((await lerSub(subId)).analysesUsed).toBe(2);

    // E o extrato mostra as três linhas, com a segunda cobrança distinguível.
    const linhas = await prisma.creditLedger.findMany({
      where: { subscriptionId: subId, analysisId: analiseId },
      orderBy: { createdAt: "asc" },
      select: { kind: true, quantity: true, idempotencyKey: true },
    });
    expect(linhas.filter((l) => l.kind === "CONSUMO").length).toBe(2);
    expect(linhas.filter((l) => l.kind === "ESTORNO").length).toBe(1);
    expect(linhas.some((l) => (l.idempotencyKey ?? "").includes(":t1"))).toBe(true);
  });

  it("a segunda cobrança também pode ser estornada", async () => {
    /**
     * O guarda do estorno era "existe algum ESTORNO desta análise?", o que travaria a
     * devolução da SEGUNDA cobrança: o cliente pagaria duas vezes e receberia uma
     * devolução. A comparação passou a ser por contagem.
     */
    const analiseId = await novaAnalise("dois ciclos de cobranca");
    await consumirCreditos(subId, analiseId, 1);
    await estornarCreditos(subId, analiseId, "primeira falha");
    await consumirCreditos(subId, analiseId, 1);

    const segundoEstorno = await estornarCreditos(subId, analiseId, "segunda falha");
    expect(segundoEstorno.jaEstornado).toBe(false);
    expect(segundoEstorno.estornados).toBe(1);
    expect((await lerSub(subId)).analysesUsed).toBe(0);

    // E não devolve uma terceira vez.
    const terceiro = await estornarCreditos(subId, analiseId, "tentativa extra");
    expect(terceiro.jaEstornado).toBe(true);
    expect(terceiro.estornados).toBe(0);
  });

  it("estornar duas vezes não credita duas vezes", async () => {
    const analiseId = await novaAnalise();
    await consumirCreditos(subId, analiseId, 2);
    await estornarCreditos(subId, analiseId, "erro");
    const segundo = await estornarCreditos(subId, analiseId, "erro");

    expect(segundo.jaEstornado).toBe(true);
    expect((await lerSub(subId)).analysesUsed).toBe(0);
  });

  it("estornar análise que nunca foi cobrada não faz nada", async () => {
    const analiseId = await novaAnalise();
    const r = await estornarCreditos(subId, analiseId, "erro");
    expect(r.estornados).toBe(0);
  });
});

describe("liberação do ciclo", () => {
  it("libera a cota do plano e marca o próximo ciclo", async () => {
    const analiseId = await novaAnalise();
    await consumirCreditos(subId, analiseId, 3);

    const r = await liberarCreditosDoCiclo(subId, { referencia: new Date("2026-08-01T00:00:00Z") });
    expect(r.liberados).toBe(8);
    const s = await lerSub(subId);
    expect(s.analysesUsed).toBe(0);
    expect(s.analysesQuota).toBe(8);
  });

  it("webhook repetido no mesmo mês não libera crédito em dobro", async () => {
    const ref = new Date("2026-08-01T00:00:00Z");
    const primeiro = await liberarCreditosDoCiclo(subId, { referencia: ref });
    const segundo = await liberarCreditosDoCiclo(subId, { referencia: ref });
    // Data diferente, mesmo mês: continua sendo o mesmo ciclo.
    const terceiro = await liberarCreditosDoCiclo(subId, { referencia: new Date("2026-08-20T00:00:00Z") });

    expect(primeiro.jaLiberado).toBe(false);
    expect(segundo.jaLiberado).toBe(true);
    expect(terceiro.jaLiberado).toBe(true);
    expect((await lerSub(subId)).analysesQuota).toBe(8);

    const liberacoes = await prisma.creditLedger.count({ where: { subscriptionId: subId, kind: "ASSINATURA" } });
    expect(liberacoes).toBe(1);
  });

  it("a PRIMEIRA liberação não lança expiração — o extrato não inventa ciclo anterior", async () => {
    /**
     * Regressão vista num pagamento real de PIX. `ativarAssinatura` grava a cota do
     * plano antes de liberar (precisa: cota 0 significaria ILIMITADO se a liberação
     * falhasse), e a primeira liberação enxergava essa cota como "sobra do ciclo
     * anterior". O extrato do cliente abria com "-20 créditos não utilizados no ciclo
     * anterior" no minuto da compra: saldo final certo, história falsa.
     */
    const subId = await novaAssinatura(20);
    // Estado igual ao que a ativação produz: cota gravada, nunca liberada.
    expect((await lerSub(subId)).creditsReleasedAt).toBeNull();

    const r = await liberarCreditosDoCiclo(subId);
    expect(r.expirados).toBe(0);

    const lancamentos = await prisma.creditLedger.findMany({
      where: { subscriptionId: subId },
      orderBy: { createdAt: "asc" },
    });
    expect(lancamentos.some((l) => l.kind === "EXPIRACAO")).toBe(false);
    // E o saldo anterior do lançamento é 0, não a cota que nunca foi liberada.
    const liberacao = lancamentos.find((l) => l.kind === "ASSINATURA")!;
    expect(liberacao.balanceBefore).toBe(0);
    // A cota vem do PLANO, não do número gravado na assinatura pelo fixture.
    expect(liberacao.balanceAfter).toBe(liberacao.quantity);
  });

  it("o crédito mensal não usado expira — não acumula para o mês seguinte", async () => {
    /**
     * A sequência precisa ser a REAL: primeiro ciclo liberado, consumo parcial,
     * segundo ciclo. O fixture criava a assinatura com cota gravada e pulava a
     * primeira liberação, e assim o teste passava a exercitar um estado que a
     * produção nunca tem — `creditsReleasedAt` nulo com cota cheia. Foi essa
     * confusão que fez a primeira liberação anunciar ao cliente, no dia da compra,
     * que 20 créditos "não utilizados no ciclo anterior" tinham expirado.
     */
    await liberarCreditosDoCiclo(subId, { referencia: new Date("2026-07-01T00:00:00Z") });
    const analiseId = await novaAnalise();
    await consumirCreditos(subId, analiseId, 3); // sobram 5

    const r = await liberarCreditosDoCiclo(subId, { referencia: new Date("2026-08-01T00:00:00Z") });
    expect(r.expirados).toBe(5);
    expect((await lerSub(subId)).analysesQuota).toBe(8); // 8, não 13

    const expiracao = await prisma.creditLedger.findFirstOrThrow({
      where: { subscriptionId: subId, kind: "EXPIRACAO" },
    });
    expect(expiracao.quantity).toBe(-5);
  });

  it("o crédito adicional comprado sobrevive à virada de ciclo", async () => {
    const sub2 = await novaAssinatura(8, 4);
    await liberarCreditosDoCiclo(sub2, { referencia: new Date("2026-08-01T00:00:00Z") });
    expect((await lerSub(sub2)).extraAnalyses).toBe(4);
  });

  it("plano anual recebe crédito mês a mês, não o ano inteiro de uma vez", async () => {
    const anual = await novaAssinatura(8, 0, true);
    const jan = await liberarCreditosDoCiclo(anual, { referencia: new Date("2026-01-10T00:00:00Z") });
    const fev = await liberarCreditosDoCiclo(anual, { referencia: new Date("2026-02-10T00:00:00Z") });

    expect(jan.liberados).toBe(8);
    expect(fev.liberados).toBe(8);
    expect(fev.jaLiberado).toBe(false);
    // O saldo continua sendo o do mês, e não 96 créditos de uma vez.
    expect((await lerSub(anual)).analysesQuota).toBe(8);
  });

  it("a chave do ciclo separa meses e junta datas do mesmo mês", () => {
    expect(chaveDoCiclo(new Date("2026-08-01T00:00:00Z"))).toBe("2026-08");
    expect(chaveDoCiclo(new Date("2026-08-31T23:00:00Z"))).toBe("2026-08");
    expect(chaveDoCiclo(new Date("2026-09-01T00:00:00Z"))).toBe("2026-09");
  });
});

describe("pacotes de créditos adicionais", () => {
  it("credita o pacote com validade e registra a movimentação", async () => {
    const r = await creditarPacote(subId, 5, { idempotencyKey: `${PREFIXO}-pacote-1`, validadeDias: 90 });

    expect(r.creditados).toBe(5);
    expect((await lerSub(subId)).extraAnalyses).toBe(5);

    const linha = await prisma.creditLedger.findFirstOrThrow({
      where: { subscriptionId: subId, kind: "COMPRA_ADICIONAL" },
    });
    expect(linha.expiresAt).toBeTruthy();
    const dias = Math.round((linha.expiresAt!.getTime() - Date.now()) / 86_400_000);
    expect(dias).toBeGreaterThanOrEqual(89);
    expect(dias).toBeLessThanOrEqual(90);
  });

  it("o mesmo pagamento reenviado não credita o pacote duas vezes", async () => {
    const chave = `${PREFIXO}-pacote-repetido`;
    await creditarPacote(subId, 5, { idempotencyKey: chave });
    const segundo = await creditarPacote(subId, 5, { idempotencyKey: chave });

    expect(segundo.jaCreditado).toBe(true);
    expect((await lerSub(subId)).extraAnalyses).toBe(5);
  });

  it("crédito adicional vencido é retirado do saldo", async () => {
    const sub2 = await novaAssinatura(0, 0);
    await creditarPacote(sub2, 3, { idempotencyKey: `${PREFIXO}-pacote-vencido`, validadeDias: -1 });
    expect((await lerSub(sub2)).extraAnalyses).toBe(3);

    await expirarCreditosAdicionais();
    expect((await lerSub(sub2)).extraAnalyses).toBe(0);

    const expiracao = await prisma.creditLedger.findFirstOrThrow({
      where: { subscriptionId: sub2, kind: "EXPIRACAO", bucket: "ADICIONAL" },
    });
    expect(expiracao.quantity).toBe(-3);
  });

  it("não expira o que o cliente já gastou", async () => {
    const sub2 = await novaAssinatura(0, 0);
    await creditarPacote(sub2, 3, { idempotencyKey: `${PREFIXO}-pacote-parcial`, validadeDias: -1 });
    const analiseId = await novaAnalise();
    await consumirCreditos(sub2, analiseId, 2); // sobra 1

    await expirarCreditosAdicionais();
    // Só o crédito que ainda existia é expirado; o saldo não fica negativo.
    expect((await lerSub(sub2)).extraAnalyses).toBe(0);
  });
});

describe("ajuste manual da administração", () => {
  it("registra quem fez, por quê, e o saldo antes e depois", async () => {
    const r = await ajustarCreditosAdmin(subId, 3, { actorId: userId, motivo: "Cortesia por indisponibilidade" });

    expect(r.saldoAnterior).toBe(8);
    expect(r.saldoPosterior).toBe(11);

    const linha = await prisma.creditLedger.findFirstOrThrow({
      where: { subscriptionId: subId, kind: "AJUSTE_ADMIN" },
    });
    expect(linha.actorId).toBe(userId);
    expect(linha.reason).toBe("Cortesia por indisponibilidade");
    expect(linha.balanceBefore).toBe(8);
    expect(linha.balanceAfter).toBe(11);
  });

  it("exige motivo — extrato sem justificativa não serve para auditoria", async () => {
    await expect(ajustarCreditosAdmin(subId, 3, { actorId: userId, motivo: "  " })).rejects.toThrow(/motivo/i);
  });

  it("retirada não deixa o saldo negativo", async () => {
    const sub2 = await novaAssinatura(8, 2);
    await expect(
      ajustarCreditosAdmin(sub2, -5, { actorId: userId, motivo: "Estorno de cortesia" }),
    ).rejects.toBeInstanceOf(SaldoInsuficienteError);
  });

  it("bônus promocional aparece com o rótulo próprio", async () => {
    await ajustarCreditosAdmin(subId, 2, { actorId: userId, motivo: "Campanha de lançamento", bonus: true });
    const linha = await prisma.creditLedger.findFirstOrThrow({ where: { subscriptionId: subId, kind: "BONUS" } });
    expect(linha.quantity).toBe(2);
  });
});

describe("telemetria legada não debita o saldo", () => {
  it("recordAnalysisConsumption grava o registro sem mexer em analysesUsed", async () => {
    // Regressão: este registro incrementava `analysesUsed` POR FORA do motor de
    // créditos, e cada análise debitava o contador duas vezes (uma no motor,
    // outra aqui). O estorno só devolvia a parte do motor, e o cliente perdia
    // um crédito fantasma por análise.
    const { recordAnalysisConsumption } = await import("../src/lib/consumption");
    const analiseId = await novaAnalise("telemetria");
    await consumirCreditos(subId, analiseId, 1);
    const antes = await lerSub(subId);

    await recordAnalysisConsumption(subId, analiseId, { input: 1000, output: 500 });

    const depois = await lerSub(subId);
    expect(depois.analysesUsed).toBe(antes.analysesUsed); // só o motor debita
    const registro = await prisma.consumptionRecord.findFirst({
      where: { subscriptionId: subId, analysisId: analiseId, kind: "analise" },
    });
    expect(registro?.aiInputTokens).toBe(1000); // a telemetria continua gravada
  });
});

describe("integridade do extrato", () => {
  it("o saldo posterior de cada linha é o anterior da seguinte", async () => {
    // O extrato é a fonte de verdade do saldo. Se a corrente quebrar, o cliente
    // vê um histórico que não fecha com o saldo que tem.
    const a1 = await novaAnalise("um");
    const a2 = await novaAnalise("dois");
    await creditarPacote(subId, 4, { idempotencyKey: `${PREFIXO}-corrente` });
    await consumirCreditos(subId, a1, 2);
    await consumirCreditos(subId, a2, 3);
    await estornarCreditos(subId, a2, "erro técnico");
    await ajustarCreditosAdmin(subId, 1, { actorId: userId, motivo: "Ajuste" });

    const linhas = await prisma.creditLedger.findMany({
      where: { subscriptionId: subId },
      orderBy: { createdAt: "asc" },
    });
    expect(linhas.length).toBeGreaterThan(4);

    for (let i = 1; i < linhas.length; i++) {
      expect(linhas[i]!.balanceAfter - linhas[i]!.balanceBefore).toBe(linhas[i]!.quantity);
      expect(linhas[i]!.balanceBefore).toBe(linhas[i - 1]!.balanceAfter);
    }

    // E o fim da corrente bate com o saldo real da assinatura.
    const s = await lerSub(subId);
    const saldoReal = Math.max(0, s.analysesQuota - s.analysesUsed) + s.extraAnalyses;
    expect(linhas[linhas.length - 1]!.balanceAfter).toBe(saldoReal);
  });
});
