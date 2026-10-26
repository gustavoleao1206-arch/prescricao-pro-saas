import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * O estorno devolvia o crédito da análise que o cliente JÁ HAVIA RECEBIDO.
 *
 * ── O defeito ─────────────────────────────────────────────────────────────────
 * A conta do estorno era "toda cobrança em aberto desta análise". Só que uma cobrança BEM-SUCEDIDA fica
 * em aberto para sempre: apenas um estorno fecha a linha de CONSUMO, e entrega não gera estorno. Então a
 * cobrança do que foi entregue era indistinguível da cobrança de uma execução que falhou.
 *
 * O caminho mais comum passa por uma PROMESSA do produto — reprocessar o mesmo material é gratuito:
 *
 *   200 páginas, 1 crédito, análise ENTREGUE → o cliente reprocessa o mesmo material (grátis) → essa
 *   rodada falha → o sistema devolvia o crédito da análise que ele já tinha em mãos.
 *
 * E a versão caríssima, com documentos acrescentados: entrega de 1 crédito, complemento de 3 pela faixa
 * nova, falha da segunda execução → devolvia 4. Junto disso, `creditsCharged` voltava a zero e a análise
 * passava a valer 4 na cobrança seguinte.
 *
 * Nenhum teste da suíte pegava isso: os 98 testes de crédito e de análise passavam com o defeito no ar.
 *
 * ── A regra que os testes daqui travam ────────────────────────────────────────
 * Devolve só o que NÃO foi entregue. O motor cobra ANTES de chamar a IA e grava o relatório DEPOIS, então
 * "cobrança criada depois do relatório mais recente" é exatamente "cobrança de execução que não entregou
 * nada". Sem relatório nenhum, tudo em aberto é devolvível.
 */

const { consumirCreditos, estornarCreditosDaAnalise, jaCobradoNaAnalise, creditoDevolvivel } =
  await import("../src/lib/credits");

const prisma = new PrismaClient();
const PREFIXO = "test-entregue";

async function limpar() {
  const orgs = await prisma.organization.findMany({ where: { name: { startsWith: PREFIXO } }, select: { id: true } });
  const orgIds = orgs.map((o) => o.id);
  if (orgIds.length) {
    const analises = await prisma.analysis.findMany({
      where: { organizationId: { in: orgIds } },
      select: { id: true },
    });
    if (analises.length) {
      await prisma.auditLog.deleteMany({ where: { entityId: { in: analises.map((a) => a.id) } } });
    }
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  }
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

beforeEach(limpar);

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

/**
 * Cenário completo. `mensal` e `adicional` separados de propósito: a bolsa de onde o crédito saiu tem de
 * ser a bolsa para onde ele volta — crédito adicional é comprado e não expira com o ciclo.
 */
async function cenario(sufixo: string, opcoes: { mensal?: number; adicional?: number } = {}) {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Cliente ${sufixo}`,
      passwordHash: "x",
      role: "CLIENTE",
      status: "ATIVO",
    },
  });
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-${sufixo}`, ownerId: user.id } });
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id, orgRole: "OWNER" } });
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-${sufixo}`,
      name: `Plano ${sufixo}`,
      priceCents: 4990,
      period: "MENSAL",
      monthlyAnalyses: opcoes.mensal ?? 20,
      maxUsers: 1,
    },
  });
  const sub = await prisma.subscription.create({
    data: {
      organizationId: org.id,
      planId: plano.id,
      status: "ATIVA",
      provider: "MANUAL",
      amountCents: 4990,
      analysesQuota: opcoes.mensal ?? 20,
      analysesUsed: 0,
      extraAnalyses: opcoes.adicional ?? 0,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  const analise = await prisma.analysis.create({
    data: { organizationId: org.id, ownerId: user.id, title: `${PREFIXO} análise`, status: "AGUARDANDO_REVISAO" },
  });
  return { user, org, sub, analise };
}

/** O relatório é o marco da ENTREGA: é ele que separa cobrança ganha de cobrança devolvível. */
async function entregar(analysisId: string) {
  const versao = ((await prisma.report.findFirst({ where: { analysisId }, orderBy: { version: "desc" } }))?.version ?? 0) + 1;
  return prisma.report.create({
    data: { analysisId, version: versao, markdown: `relatório v${versao}`, content: {} },
  });
}

const saldo = async (subId: string) => {
  const s = await prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
  return { usado: s.analysesUsed, adicional: s.extraAnalyses };
};

const cobradoNaAnalise = async (id: string) =>
  (await prisma.analysis.findUniqueOrThrow({ where: { id } })).creditsCharged;

describe("⚠️ o crédito do que foi ENTREGUE não volta", () => {
  it("⚠️⚠️ entrega de 1 + complemento de 3 que falha devolve 3, NÃO 4", async () => {
    /**
     * O achado, em números. A cobrança da entrega fica em aberto para sempre, e a conta antiga a somava:
     * devolvia 4 por uma falha que custou 3 — dando de graça o crédito de uma análise que o cliente
     * recebeu, leu e talvez tenha protocolado.
     */
    const c = await cenario("complemento");
    await consumirCreditos(c.sub.id, c.analise.id, 1, "Análise de 200 páginas");
    const relatorio = await entregar(c.analise.id);
    // Documentos acrescentados: o processo sobe de faixa e o complemento é cobrado.
    await consumirCreditos(c.sub.id, c.analise.id, 4, "Análise de 900 páginas");
    expect((await saldo(c.sub.id)).usado).toBe(4);

    /** A ordem no tempo é o que a regra usa; deixá-la afirmada evita depender de sorte. */
    const linhas = await prisma.creditLedger.findMany({
      where: { analysisId: c.analise.id, kind: "CONSUMO" },
      orderBy: { createdAt: "asc" },
    });
    expect(linhas[0]!.createdAt.getTime()).toBeLessThan(relatorio.createdAt.getTime());
    expect(linhas[1]!.createdAt.getTime()).toBeGreaterThan(relatorio.createdAt.getTime());

    const r = await estornarCreditosDaAnalise(c.analise.id, "erro técnico no processamento");

    expect(r.estornados).toBe(3);
    expect((await saldo(c.sub.id)).usado).toBe(1);
    /**
     * E o registro do que a análise custou passa a ser 1, não zero. Zerar fazia a rota de processar e o
     * extrato interno afirmarem que ela nunca foi cobrada, com o crédito da entrega ainda debitado.
     */
    expect(await cobradoNaAnalise(c.analise.id)).toBe(1);
    expect(await jaCobradoNaAnalise(c.sub.id, c.analise.id)).toBe(1);
  });

  it("⚠️ reprocessar o MESMO material e falhar devolve ZERO — o caso mais comum", async () => {
    /**
     * Este é o caminho que qualquer cliente percorre, porque reprocessar o mesmo material de graça é
     * promessa do produto. A análise foi entregue e cobrada uma vez; a reexecução não cobra nada; se ela
     * falha, não há o que devolver. A conta antiga devolvia 1 — o crédito da entrega.
     */
    const c = await cenario("mesmo-material");
    await consumirCreditos(c.sub.id, c.analise.id, 1, "Análise");
    await entregar(c.analise.id);
    // Reexecução do mesmo material: nada é debitado (complemento zero).
    const segunda = await consumirCreditos(c.sub.id, c.analise.id, 1, "Análise");
    expect(segunda.jaConsumido).toBe(true);

    const r = await estornarCreditosDaAnalise(c.analise.id, "erro técnico no processamento");

    expect(r.estornados).toBe(0);
    expect((await saldo(c.sub.id)).usado).toBe(1);
    expect(await cobradoNaAnalise(c.analise.id)).toBe(1);
  });

  it("primeira execução que falha SEM relatório devolve tudo — a regra não pode quebrar o caso normal", async () => {
    /**
     * O caso que o estorno existe para atender: o cliente pagou e não recebeu nada. Sem relatório, toda
     * cobrança em aberto é devolvível.
     */
    const c = await cenario("primeira-falha");
    await consumirCreditos(c.sub.id, c.analise.id, 2, "Análise");

    const r = await estornarCreditosDaAnalise(c.analise.id, "erro técnico no processamento");

    expect(r.estornados).toBe(2);
    expect((await saldo(c.sub.id)).usado).toBe(0);
    expect(await cobradoNaAnalise(c.analise.id)).toBe(0);
  });

  it("falha DEPOIS de gravar o relatório não devolve — mesma regra do cancelamento", async () => {
    /**
     * Escolha declarada, não esquecimento: o relatório existe e a tela do cliente o mostra (ela não olha
     * o status para renderizar), e o custo com o provedor de IA foi pago. O cancelamento já se comporta
     * assim — não devolve quando há relatório. Uma regra só nos dois lugares vale mais que otimizar
     * este canto.
     */
    const c = await cenario("falha-pos-relatorio");
    await consumirCreditos(c.sub.id, c.analise.id, 1, "Análise");
    await entregar(c.analise.id);

    expect((await estornarCreditosDaAnalise(c.analise.id, "falhou ao gerar a peça")).estornados).toBe(0);
    expect((await saldo(c.sub.id)).usado).toBe(1);
  });

  it("⚠️ devolve à bolsa de ONDE saiu: complemento pago com crédito adicional volta para lá", async () => {
    /**
     * Crédito adicional é comprado e não expira com o ciclo; devolvê-lo como mensal faria o cliente
     * perder na virada o que pagou à parte. Aqui a bolsa mensal cabe só a entrega, e o complemento sai
     * inteiro do adicional.
     */
    const c = await cenario("bolsas", { mensal: 1, adicional: 5 });
    await consumirCreditos(c.sub.id, c.analise.id, 1, "Análise de 200 páginas");
    await entregar(c.analise.id);
    await consumirCreditos(c.sub.id, c.analise.id, 4, "Análise de 900 páginas");
    expect(await saldo(c.sub.id)).toEqual({ usado: 1, adicional: 2 });

    const r = await estornarCreditosDaAnalise(c.analise.id, "erro técnico no processamento");

    expect(r.estornados).toBe(3);
    // A entrega continua consumindo a mensal; os três voltam para a adicional.
    expect(await saldo(c.sub.id)).toEqual({ usado: 1, adicional: 5 });
  });

  it("estornar duas vezes não devolve em dobro", async () => {
    const c = await cenario("idempotente");
    await consumirCreditos(c.sub.id, c.analise.id, 1, "Análise");
    await entregar(c.analise.id);
    await consumirCreditos(c.sub.id, c.analise.id, 4, "Análise maior");

    expect((await estornarCreditosDaAnalise(c.analise.id, "erro")).estornados).toBe(3);
    const segunda = await estornarCreditosDaAnalise(c.analise.id, "erro");

    expect(segunda.estornados).toBe(0);
    expect(segunda.jaEstornado).toBe(true);
    expect((await saldo(c.sub.id)).usado).toBe(1);
  });
});

describe("⚠️ depois da devolução parcial, a análise NÃO fica de graça", () => {
  it("nova tentativa cobra o complemento outra vez", async () => {
    /**
     * A outra metade do furo, em `consumirCreditos`: `jaCobrado` somava as linhas de CONSUMO e ignorava
     * os ESTORNOS. Depois de devolver 3, ele continuava achando que 4 já haviam sido pagos — então a
     * tentativa seguinte cobrava ZERO, e o cliente ficava com uma análise de 4 créditos por 1, para
     * sempre.
     *
     * Com a conta líquida, quem recebeu 3 de volta paga 3 de novo ao reexecutar.
     */
    const c = await cenario("nao-de-graca");
    await consumirCreditos(c.sub.id, c.analise.id, 1, "Análise");
    await entregar(c.analise.id);
    await consumirCreditos(c.sub.id, c.analise.id, 4, "Análise maior");
    await estornarCreditosDaAnalise(c.analise.id, "erro técnico no processamento");
    expect((await saldo(c.sub.id)).usado).toBe(1);

    const terceira = await consumirCreditos(c.sub.id, c.analise.id, 4, "Análise maior");

    expect(terceira.jaConsumido).toBe(false);
    expect((await saldo(c.sub.id)).usado).toBe(4);
  });

  it("e o 'já cobrado' que a TELA mostra concorda com o que a cobrança pensa", async () => {
    /**
     * `jaCobradoNaAnalise` alimenta o orçamento mostrado ao cliente e sempre calculou líquido; o
     * `jaCobrado` interno calculava bruto. O cliente lia "esta análise já consumiu 1 crédito" enquanto a
     * cobrança acreditava que eram 4 — e por isso não cobrava nada.
     */
    const c = await cenario("tela-concorda");
    await consumirCreditos(c.sub.id, c.analise.id, 1, "Análise");
    await entregar(c.analise.id);
    await consumirCreditos(c.sub.id, c.analise.id, 4, "Análise maior");
    await estornarCreditosDaAnalise(c.analise.id, "erro");

    /** O que a tela diz. Com 1 já pago e custo de 4, o orçamento pede a diferença de 3. */
    expect(await jaCobradoNaAnalise(c.sub.id, c.analise.id)).toBe(1);
    const proxima = await consumirCreditos(c.sub.id, c.analise.id, 4, "Análise maior");
    expect(proxima.complementoCobrado).toBe(3);
  });

  it("reprocessar o mesmo material continua GRATUITO — a promessa do produto sobrevive", async () => {
    /**
     * O risco de tornar a conta líquida seria cobrar duas vezes pelo mesmo trabalho. Sem devolução no
     * meio, líquido e bruto são iguais, e a reexecução do mesmo material segue custando zero.
     */
    const c = await cenario("gratuito");
    await consumirCreditos(c.sub.id, c.analise.id, 2, "Análise");
    await entregar(c.analise.id);

    const segunda = await consumirCreditos(c.sub.id, c.analise.id, 2, "Análise");

    expect(segunda.jaConsumido).toBe(true);
    expect((await saldo(c.sub.id)).usado).toBe(2);
  });
});

/**
 * O aviso de EXCLUIR precisa dizer um número VERDADEIRO.
 *
 * Excluir e Cancelar ficam lado a lado na barra de ações e parecem alternativas do mesmo tipo. Não são:
 * Cancelar devolve o crédito quando nada foi entregue e preserva os documentos; Excluir apaga tudo e não
 * devolve nada. Quem tem uma análise que falhou quer "se livrar dela" — e escolhia o botão que custa
 * dinheiro, sem saber que havia outro caminho.
 *
 * `creditoDevolvivel` responde pela MESMA conta do estorno, de propósito. Um número na tela que não seja
 * exatamente o que o estorno devolveria é pior que nenhum número: ensina a pessoa a desconfiar do aviso.
 */
describe("⚠️ o aviso de excluir diz o mesmo número que o estorno devolveria", () => {
  it("análise em erro sem relatório: o aviso mostra o que Cancelar devolveria", async () => {
    const c = await cenario("aviso-erro");
    await consumirCreditos(c.sub.id, c.analise.id, 2, "Análise");

    const aPerder = await creditoDevolvivel(c.analise.id);

    expect(aPerder).toBe(2);
    /** E é EXATAMENTE o que o estorno devolve — é o ponto de a conta ser uma só. */
    expect((await estornarCreditosDaAnalise(c.analise.id, "cancelada")).estornados).toBe(aPerder);
  });

  it("⚠️ com entrega e complemento, avisa só o complemento", async () => {
    const c = await cenario("aviso-complemento");
    await consumirCreditos(c.sub.id, c.analise.id, 1, "Análise");
    await entregar(c.analise.id);
    await consumirCreditos(c.sub.id, c.analise.id, 4, "Análise maior");

    const aPerder = await creditoDevolvivel(c.analise.id);

    expect(aPerder).toBe(3);
    expect((await estornarCreditosDaAnalise(c.analise.id, "cancelada")).estornados).toBe(aPerder);
  });

  it("análise ENTREGUE não tem crédito a perder — e o aviso não aparece", async () => {
    /**
     * Zero é o que faz o aviso desaparecer. Avisar sempre treinaria a pessoa a ignorá-lo, inclusive na
     * vez em que ele importa.
     */
    const c = await cenario("aviso-entregue");
    await consumirCreditos(c.sub.id, c.analise.id, 1, "Análise");
    await entregar(c.analise.id);

    expect(await creditoDevolvivel(c.analise.id)).toBe(0);
  });

  it("crédito já devolvido não é avisado de novo", async () => {
    const c = await cenario("aviso-ja-devolvido");
    await consumirCreditos(c.sub.id, c.analise.id, 1, "Análise");
    await estornarCreditosDaAnalise(c.analise.id, "erro técnico");

    expect(await creditoDevolvivel(c.analise.id)).toBe(0);
  });

  it("análise sem cobrança nenhuma não avisa nada", async () => {
    const c = await cenario("aviso-sem-cobranca");

    expect(await creditoDevolvivel(c.analise.id)).toBe(0);
  });
});

describe("a varredura de manutenção herda a mesma regra", () => {
  it("⚠️ execução abandonada depois de uma entrega devolve só o complemento", async () => {
    /**
     * A varredura chama o mesmo estorno, e por isso tinha o mesmo furo: análise entregue, documentos
     * acrescentados, processo morto no meio (deploy, tempo limite, falta de memória) — e ela devolvia
     * também o crédito da entrega, sem ninguém perceber, na madrugada.
     */
    const { destravarSeAbandonada, MINUTOS_SEM_SINAL_DE_VIDA } = await import("../src/lib/analise-travada");
    const c = await cenario("varredura");
    await consumirCreditos(c.sub.id, c.analise.id, 1, "Análise");
    await entregar(c.analise.id);
    await consumirCreditos(c.sub.id, c.analise.id, 4, "Análise maior");
    // A execução seguinte morre: status de processamento e sinal de vida velho.
    await prisma.analysis.update({
      where: { id: c.analise.id },
      data: {
        status: "PROCESSANDO",
        heartbeatAt: new Date(Date.now() - (MINUTOS_SEM_SINAL_DE_VIDA + 10) * 60_000),
      },
    });

    const r = await destravarSeAbandonada(c.analise.id);

    expect(r.destravada).toBe(true);
    expect(r.creditosEstornados).toBe(3);
    expect((await saldo(c.sub.id)).usado).toBe(1);
  });
});
