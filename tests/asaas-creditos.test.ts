import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * A chave precisa existir ANTES do import: `env` é lido no carregamento do módulo, e sem
 * ela o cliente HTTP recusa toda chamada — os testes que verificam a conversa com o
 * provedor passariam a medir "não tentou", não "tentou e conseguiu".
 */
process.env.ASAAS_API_KEY = "chave-de-teste-nao-vai-para-a-rede";
process.env.ASAAS_ENV = "sandbox";

const { processAsaasEvent } = await import("../src/lib/asaas");
const { saldoDe } = await import("../src/lib/credits");

/**
 * Webhook do Asaas × créditos.
 *
 * O Asaas é o gateway por onde o dinheiro entra, e até aqui não tinha nenhum
 * teste. Estes casos cobrem o que custa dinheiro quando dá errado:
 *
 *  - o Asaas manda DOIS eventos por pagamento de cartão (PAYMENT_CONFIRMED na
 *    aprovação e PAYMENT_RECEIVED na liquidação). Os dois classificam como
 *    "aprovado", com o mesmo id de pagamento. Se isso creditasse duas vezes,
 *    todo cliente de cartão receberia cota dobrada — prejuízo em cada venda;
 *  - o reenvio de webhook é comportamento normal de gateway, não exceção;
 *  - a renovação chega SEM externalReference e só se liga à conta pelo id da
 *    assinatura no Asaas. Se esse vínculo falhar, o cliente paga o segundo mês e
 *    não recebe crédito nenhum;
 *  - o estorno devolve o dinheiro, então o saldo não usado tem de ser bloqueado;
 *  - upgrade no meio do mês precisa entregar a diferença de cota que foi paga.
 *
 * Vai ao banco de verdade porque é lá que a idempotência mora: na chave do ciclo
 * e na deduplicação de Payment. Mock não prova nada disso.
 *
 * Todo dado criado leva o prefixo `test-asaas` e é apagado ao final.
 */

const prisma = new PrismaClient();
const PREFIXO = "test-asaas";

let planoEssencialId = "";
let planoProfId = "";

interface Conta {
  userId: string;
  orgId: string;
}

async function criarConta(sufixo: string): Promise<Conta> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Cliente Asaas ${sufixo}`,
      role: "CLIENTE",
      status: "ATIVO",
      emailVerifiedAt: new Date(),
    },
  });
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-${sufixo}`, ownerId: user.id } });
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id, orgRole: "OWNER" } });
  return { userId: user.id, orgId: org.id };
}

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const orgs = await prisma.organization.findMany({
    where: { OR: [{ name: { startsWith: PREFIXO } }, { ownerId: { in: users.map((u) => u.id) } }] },
    select: { id: true },
  });
  const ids = orgs.map((o) => o.id);
  if (ids.length) {
    const subs = await prisma.subscription.findMany({ where: { organizationId: { in: ids } }, select: { id: true } });
    const subIds = subs.map((s) => s.id);
    await prisma.creditLedger.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await prisma.payment.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await prisma.subscription.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.user.updateMany({ where: { organizationId: { in: ids } }, data: { organizationId: null } });
    await prisma.organization.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.authToken.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: users.map((u) => u.id) } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIXO } } });
  await prisma.creditPack.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

/** Payload no formato do webhook do Asaas. */
function evento(opts: {
  event: string;
  pagamento: string;
  ref?: string;
  valor?: number;
  assinatura?: string;
  forma?: string;
}) {
  return {
    event: opts.event,
    payment: {
      id: opts.pagamento,
      customer: `cus_${PREFIXO}`,
      subscription: opts.assinatura,
      value: opts.valor,
      billingType: opts.forma ?? "CREDIT_CARD",
      status: "CONFIRMED",
      externalReference: opts.ref,
    },
  };
}

const refPlano = (slug: string, userId: string) => `plano:${slug}:user:${userId}`;
const refPacote = (slug: string, userId: string) => `pacote:${slug}:user:${userId}`;
/** Cobrança AVULSA da diferença proporcional da troca de plano. */
const refUpgrade = (slug: string, userId: string) => `upgrade:${slug}:user:${userId}`;

async function assinaturaDe(orgId: string) {
  return prisma.subscription.findFirstOrThrow({ where: { organizationId: orgId }, orderBy: { createdAt: "desc" } });
}

beforeAll(async () => {
  await limpar();
  const essencial = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-essencial`,
      name: "Asaas Essencial",
      priceCents: 3990,
      period: "MENSAL",
      monthlyAnalyses: 2,
      maxUsers: 1,
    },
  });
  planoEssencialId = essencial.id;
  const prof = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-profissional`,
      name: "Asaas Profissional",
      priceCents: 11990,
      period: "MENSAL",
      monthlyAnalyses: 8,
      maxUsers: 1,
    },
  });
  planoProfId = prof.id;
  await prisma.creditPack.create({
    data: { slug: `${PREFIXO}-pacote-5`, name: "Asaas Pacote 5", credits: 5, priceCents: 7490, validityDays: 90 },
  });
});

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Zera contas/assinaturas entre casos; planos e pacote permanecem.
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const orgs = await prisma.organization.findMany({
    where: { ownerId: { in: users.map((u) => u.id) } },
    select: { id: true },
  });
  const ids = orgs.map((o) => o.id);
  const subs = await prisma.subscription.findMany({ where: { organizationId: { in: ids } }, select: { id: true } });
  const subIds = subs.map((s) => s.id);
  await prisma.creditLedger.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.payment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscription.deleteMany({ where: { organizationId: { in: ids } } });
  await prisma.user.updateMany({ where: { organizationId: { in: ids } }, data: { organizationId: null } });
  await prisma.organization.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIXO } } });
});

describe("primeira compra pelo checkout", () => {
  it("ativa a assinatura no provedor ASAAS e credita a cota do plano", async () => {
    const conta = await criarConta("nova");

    const r = await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `${PREFIXO}-sub-1`,
      }),
    );

    expect(r.action).toBe("aprovado");
    const sub = await assinaturaDe(conta.orgId);
    expect(sub.status).toBe("ATIVA");
    expect(sub.provider).toBe("ASAAS");
    expect(sub.planId).toBe(planoProfId);
    expect(sub.amountCents).toBe(11990);
    expect(saldoDe(sub).total).toBe(8);

    // Guarda o id da assinatura no Asaas: é o único vínculo que as renovações têm.
    expect(sub.externalRef).toBe(`${PREFIXO}-sub-1`);

    const liberacoes = await prisma.creditLedger.count({ where: { subscriptionId: sub.id, kind: "ASSINATURA" } });
    expect(liberacoes).toBe(1);
    const pagamentos = await prisma.payment.count({ where: { subscriptionId: sub.id, status: "APROVADO" } });
    expect(pagamentos).toBe(1);
  });

  it("usa o preço do plano quando o evento vem sem valor", async () => {
    const conta = await criarConta("semvalor");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-sv`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        assinatura: `${PREFIXO}-sub-sv`,
      }),
    );
    const sub = await assinaturaDe(conta.orgId);
    expect(sub.amountCents).toBe(3990);
  });
});

describe("idempotência — o ponto que protege o caixa", () => {
  it("o par CONFIRMED→RECEIVED do mesmo pagamento credita uma única vez", async () => {
    const conta = await criarConta("par");
    const base = {
      pagamento: `${PREFIXO}-pay-par`,
      ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
      valor: 119.9,
      assinatura: `${PREFIXO}-sub-par`,
    };

    // É o comportamento normal do Asaas em cartão: aprova e depois liquida.
    await processAsaasEvent(evento({ ...base, event: "PAYMENT_CONFIRMED" }));
    await processAsaasEvent(evento({ ...base, event: "PAYMENT_RECEIVED" }));

    const sub = await assinaturaDe(conta.orgId);
    expect(sub.analysesQuota).toBe(8); // não 16
    expect(saldoDe(sub).total).toBe(8);
    const liberacoes = await prisma.creditLedger.count({ where: { subscriptionId: sub.id, kind: "ASSINATURA" } });
    expect(liberacoes).toBe(1);
    const pagamentos = await prisma.payment.count({
      where: { subscriptionId: sub.id, externalId: base.pagamento, status: "APROVADO" },
    });
    expect(pagamentos).toBe(1);
  });

  it("o mesmo evento reenviado não credita duas vezes", async () => {
    const conta = await criarConta("reenvio");
    const ev = evento({
      event: "PAYMENT_CONFIRMED",
      pagamento: `${PREFIXO}-pay-re`,
      ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
      valor: 119.9,
      assinatura: `${PREFIXO}-sub-re`,
    });

    await processAsaasEvent(ev);
    await processAsaasEvent(ev);

    const sub = await assinaturaDe(conta.orgId);
    expect(sub.analysesQuota).toBe(8);
    const liberacoes = await prisma.creditLedger.count({ where: { subscriptionId: sub.id, kind: "ASSINATURA" } });
    expect(liberacoes).toBe(1);
  });

  it("não zera o consumo do cliente quando o evento é reprocessado", async () => {
    const conta = await criarConta("consumo");
    const ev = evento({
      event: "PAYMENT_CONFIRMED",
      pagamento: `${PREFIXO}-pay-cons`,
      ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
      valor: 119.9,
      assinatura: `${PREFIXO}-sub-cons`,
    });
    await processAsaasEvent(ev);

    const sub1 = await assinaturaDe(conta.orgId);
    await prisma.subscription.update({ where: { id: sub1.id }, data: { analysesUsed: 3 } });

    // Reenvio do webhook não pode devolver ao cliente o que ele já gastou.
    await processAsaasEvent(ev);

    const sub2 = await assinaturaDe(conta.orgId);
    expect(sub2.analysesUsed).toBe(3);
    expect(saldoDe(sub2).total).toBe(5);
  });
});

describe("renovação (segundo mês em diante)", () => {
  it("reconhece a renovação pelo id da assinatura Asaas, sem externalReference", async () => {
    const conta = await criarConta("renova");
    const idAssinatura = `${PREFIXO}-sub-renova`;

    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-r1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: idAssinatura,
      }),
    );

    // A renovação chega sem externalReference — só com o id da assinatura.
    const r = await processAsaasEvent(
      evento({ event: "PAYMENT_CONFIRMED", pagamento: `${PREFIXO}-pay-r2`, valor: 119.9, assinatura: idAssinatura }),
    );

    expect(r.action).toBe("aprovado");
    const sub = await assinaturaDe(conta.orgId);
    expect(sub.status).toBe("ATIVA");
    /**
     * A COTA POR CICLO não dobra — 8 continua 8, porque a liberação zera e repõe em
     * vez de acumular. Mas houve DUAS liberações, uma por cobrança paga.
     *
     * Este teste afirmava o contrário: "mesmo mês, a cota não dobra" com UMA
     * liberação para DOIS pagamentos distintos. Era o defeito escrito como regra — a
     * chave de idempotência era o mês civil, então a segunda cobrança paga liberava
     * zero e nem zerava o consumo. Quem pagou duas vezes recebia uma. O teste passava
     * e protegia o defeito; hoje o ciclo é o pagamento, e o número certo é 2.
     */
    expect(sub.analysesQuota).toBe(8);
    expect(sub.analysesUsed).toBe(0);
    const liberacoes = await prisma.creditLedger.count({
      where: { subscriptionId: sub.id, kind: "ASSINATURA", quantity: { gt: 0 } },
    });
    expect(liberacoes).toBe(2);
    // Mas o pagamento da renovação é registrado — é receita nova.
    const pagamentos = await prisma.payment.count({ where: { subscriptionId: sub.id, status: "APROVADO" } });
    expect(pagamentos).toBe(2);
  });

  it("reativa quem estava suspenso por atraso ao pagar a renovação", async () => {
    const conta = await criarConta("volta");
    const idAssinatura = `${PREFIXO}-sub-volta`;
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-v1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: idAssinatura,
      }),
    );
    await processAsaasEvent(
      evento({ event: "PAYMENT_OVERDUE", pagamento: `${PREFIXO}-pay-v2`, assinatura: idAssinatura }),
    );
    expect((await assinaturaDe(conta.orgId)).status).toBe("INADIMPLENTE");

    await processAsaasEvent(
      evento({ event: "PAYMENT_CONFIRMED", pagamento: `${PREFIXO}-pay-v3`, valor: 119.9, assinatura: idAssinatura }),
    );

    const sub = await assinaturaDe(conta.orgId);
    expect(sub.status).toBe("ATIVA");
    expect(sub.suspendedAt).toBeNull();
    expect(sub.graceUntil).toBeNull();
  });

  it("recusa e registra a renovação que não casa com nenhuma assinatura", async () => {
    const r = await processAsaasEvent(
      evento({ event: "PAYMENT_CONFIRMED", pagamento: `${PREFIXO}-pay-orfao`, valor: 119.9, assinatura: `${PREFIXO}-sub-inexistente` }),
    );

    expect(r.action).toBe("ignorado");
    /**
     * A prova é a QUANTIA registrada, não um evento de segurança achado com `findFirst`
     * na tabela inteira. Aquela busca passava por causa de linhas de outros testes — e
     * quando o tipo de evento mudou (hoje é `asaas_dinheiro_sem_destino`), o teste
     * continuou verde provando o passado. O pagamento carrega o prefixo deste arquivo.
     */
    const registro = await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-pay-orfao` } });
    expect(registro?.status).toBe("PENDENTE");
    expect(registro?.subscriptionId).toBeNull();
    expect(registro?.amountCents).toBe(11990);
  });
});

describe("upgrade e downgrade pelo checkout", () => {
  it("upgrade no mesmo mês entrega a diferença de cota que foi paga", async () => {
    const conta = await criarConta("upgrade");

    // Assina o Essencial (2 créditos) e consome 1.
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-up1`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-up1`,
      }),
    );
    const inicial = await assinaturaDe(conta.orgId);
    expect(inicial.analysesQuota).toBe(2);
    await prisma.subscription.update({ where: { id: inicial.id }, data: { analysesUsed: 1 } });

    // Uma semana depois sobe para o Profissional (8) e PAGA por isso.
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-up2`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `${PREFIXO}-sub-up2`,
      }),
    );

    const depois = await assinaturaDe(conta.orgId);
    expect(depois.planId).toBe(planoProfId);
    // A cota tem de chegar à do plano novo. Sem isso, o cliente paga o plano
    // maior e continua com a cota do menor até o mês seguinte.
    expect(depois.analysesQuota).toBe(8);
    // E o que ele já gastou continua gasto — o upgrade não devolve consumo.
    expect(depois.analysesUsed).toBe(1);
    expect(saldoDe(depois).total).toBe(7);
  });

  it("downgrade não tira no meio do mês a cota já paga", async () => {
    const conta = await criarConta("downgrade");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-dn1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `${PREFIXO}-sub-dn1`,
      }),
    );

    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-dn2`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-dn2`,
      }),
    );

    const sub = await assinaturaDe(conta.orgId);
    // O cliente pagou o mês no plano maior: a cota do ciclo corrente não cai.
    expect(sub.analysesQuota).toBe(8);
    // O plano menor fica agendado para a renovação.
    expect(sub.pendingPlanId).toBe(planoEssencialId);
  });
});

describe("upgrade proporcional pela tela 'mudar plano'", () => {

  it("sobe o plano, soma a diferença de cota e preserva o ciclo já pago", async () => {
    const conta = await criarConta("prop");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-pr1`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-pr1`,
      }),
    );
    const antes = await assinaturaDe(conta.orgId);
    await prisma.subscription.update({ where: { id: antes.id }, data: { analysesUsed: 1 } });
    const cicloOriginal = antes.currentPeriodEnd;

    // A cobrança da diferença proporcional é AVULSA: R$ 40,00 por meio ciclo.
    const r = await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-pr2`,
        ref: refUpgrade(`${PREFIXO}-profissional`, conta.userId),
        valor: 40,
        forma: "PIX",
      }),
    );

    expect(r.action).toBe("aprovado");
    const depois = await assinaturaDe(conta.orgId);
    expect(depois.planId).toBe(planoProfId);
    // Cota completada de 2 para 8, consumo preservado.
    expect(depois.analysesQuota).toBe(8);
    expect(depois.analysesUsed).toBe(1);
    expect(saldoDe(depois).total).toBe(7);
    // O ciclo pago NÃO é reiniciado: a cobrança cobriu só os dias que faltavam.
    expect(depois.currentPeriodEnd?.getTime()).toBe(cicloOriginal?.getTime());
    // A recorrência passa a valer pelo preço do plano novo.
    expect(depois.amountCents).toBe(11990);
  });

  it("o par CONFIRMED→RECEIVED do upgrade não soma a cota duas vezes", async () => {
    const conta = await criarConta("prop2");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-pq1`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-pq1`,
      }),
    );

    const base = {
      pagamento: `${PREFIXO}-pay-pq2`,
      ref: refUpgrade(`${PREFIXO}-profissional`, conta.userId),
      valor: 40,
      forma: "PIX",
    };
    await processAsaasEvent(evento({ ...base, event: "PAYMENT_CONFIRMED" }));
    await processAsaasEvent(evento({ ...base, event: "PAYMENT_RECEIVED" }));

    const sub = await assinaturaDe(conta.orgId);
    expect(sub.analysesQuota).toBe(8); // não 14
    const complementos = await prisma.creditLedger.count({
      where: { subscriptionId: sub.id, description: { contains: "complemento de cota" } },
    });
    expect(complementos).toBe(1);
  });

  it("upgrade pago sem assinatura vira caso de suporte, não pagamento perdido", async () => {
    const conta = await criarConta("prop3");
    const r = await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-pz1`,
        ref: refUpgrade(`${PREFIXO}-profissional`, conta.userId),
        valor: 40,
        forma: "PIX",
      }),
    );
    expect(r.action).toBe("ignorado");
    /**
     * A prova é o REGISTRO da quantia, não a existência de um evento de segurança.
     *
     * A versão anterior deste teste procurava `webhook_upgrade_sem_assinatura` com
     * `findFirst` na tabela inteira — que a limpeza não apaga. Quando o tipo de
     * evento mudou, o teste continuou passando por causa de linhas de execuções
     * antigas: passou a provar o passado, não o código. O pagamento é identificado
     * pelo prefixo do teste e some junto com ele.
     */
    const registro = await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-pay-pz1` } });
    expect(registro?.status).toBe("PENDENTE");
    expect(registro?.amountCents).toBe(4000);
  });
});

describe("downgrade agendado é aplicado na renovação", () => {
  it("troca para o plano menor quando a data agendada já passou", async () => {
    const conta = await criarConta("agendado");
    const idAssinatura = `${PREFIXO}-sub-ag`;
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-ag1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: idAssinatura,
      }),
    );
    const sub = await assinaturaDe(conta.orgId);

    // Estado deixado por um downgrade pedido no ciclo anterior.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { pendingPlanId: planoEssencialId, pendingPlanAt: new Date(Date.now() - 86_400_000) },
    });

    // Chega o pagamento da renovação.
    await processAsaasEvent(
      evento({ event: "PAYMENT_CONFIRMED", pagamento: `${PREFIXO}-pay-ag2`, valor: 39.9, assinatura: idAssinatura }),
    );

    const depois = await assinaturaDe(conta.orgId);
    // Este era o bug: pendingPlanId era gravado e nunca lido, então o cliente
    // seguia no plano caro para sempre.
    expect(depois.planId).toBe(planoEssencialId);
    expect(depois.pendingPlanId).toBeNull();
    expect(depois.pendingPlanAt).toBeNull();
    expect(depois.amountCents).toBe(3990);
  });

  it("não antecipa o downgrade cuja data ainda não chegou", async () => {
    const conta = await criarConta("agendado2");
    const idAssinatura = `${PREFIXO}-sub-ag2`;
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-ah1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: idAssinatura,
      }),
    );
    const sub = await assinaturaDe(conta.orgId);
    const daquiUmMes = new Date(Date.now() + 30 * 86_400_000);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { pendingPlanId: planoEssencialId, pendingPlanAt: daquiUmMes },
    });

    await processAsaasEvent(
      evento({ event: "PAYMENT_CONFIRMED", pagamento: `${PREFIXO}-pay-ah2`, valor: 119.9, assinatura: idAssinatura }),
    );

    const depois = await assinaturaDe(conta.orgId);
    expect(depois.planId).toBe(planoProfId); // continua no plano pago
    expect(depois.pendingPlanId).toBe(planoEssencialId); // e o agendamento segue de pé
  });
});

describe("ciclo de crédito: pagamento, não mês do calendário", () => {
  /**
   * A raiz de quatro achados da auditoria do caminho do dinheiro.
   *
   * A chave de idempotência da liberação era `ciclo:<id>:<AAAA-MM>` — uma liberação
   * por MÊS CIVIL. Ciclo de assinatura não anda em mês civil, e basta um pagamento
   * atrasado para os dois se descolarem: cobrança de 28/08 paga em 02/09 libera o mês
   * 09, e a cobrança seguinte, de 28/09, cai no mesmo mês civil e libera ZERO. O
   * cliente paga e não recebe nada. Agora o ciclo é o PAGAMENTO.
   */
  it("dois pagamentos no MESMO mês civil liberam DUAS cotas", async () => {
    const conta = await criarConta("dois-no-mes");

    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-mm1`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-mm`,
      }),
    );
    const primeira = await assinaturaDe(conta.orgId);
    const cota = primeira.analysesQuota;
    expect(cota).toBeGreaterThan(0);

    // O cliente gasta tudo e, no MESMO mês, a cobrança seguinte é paga.
    await prisma.subscription.update({ where: { id: primeira.id }, data: { analysesUsed: cota } });
    await processAsaasEvent(
      evento({
        event: "PAYMENT_RECEIVED",
        pagamento: `${PREFIXO}-pay-mm2`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-mm`,
      }),
    );

    const depois = await assinaturaDe(conta.orgId);
    // Antes: consumo continuava cheio e nenhuma cota nova entrava.
    expect(depois.analysesUsed).toBe(0);
    expect(saldoDe(depois).total).toBe(cota);

    const liberacoes = await prisma.creditLedger.count({
      where: { subscriptionId: depois.id, kind: "ASSINATURA", quantity: { gt: 0 } },
    });
    expect(liberacoes).toBe(2);
  });

  it("dois pagamentos SOMAM período: cada cobrança paga compra um ciclo", async () => {
    const conta = await criarConta("soma-periodo");

    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-sp1`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-sp`,
      }),
    );
    const primeiro = (await assinaturaDe(conta.orgId)).currentPeriodEnd!;

    await processAsaasEvent(
      evento({
        event: "PAYMENT_RECEIVED",
        pagamento: `${PREFIXO}-pay-sp2`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-sp`,
      }),
    );
    const segundo = (await assinaturaDe(conta.orgId)).currentPeriodEnd!;

    /**
     * Dois boletos em aberto pagos no mesmo dia compravam UM mês: o período era
     * reescrito com agora + 1 mês em vez de estendido. R$ 79,80 por trinta dias.
     */
    const diasSomados = Math.round((segundo.getTime() - primeiro.getTime()) / 86_400_000);
    expect(diasSomados).toBeGreaterThanOrEqual(28);
  });

  it("o par CONFIRMED→RECEIVED do MESMO pagamento não soma dois meses", async () => {
    const conta = await criarConta("par-evento");
    const pagamento = `${PREFIXO}-pay-par1`;

    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-par`,
      }),
    );
    const depoisDoPrimeiro = (await assinaturaDe(conta.orgId)).currentPeriodEnd!;

    // MESMO pagamento, segundo evento — é o que o Asaas faz em toda cobrança.
    await processAsaasEvent(
      evento({
        event: "PAYMENT_RECEIVED",
        pagamento,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-par`,
      }),
    );
    const depoisDoSegundo = (await assinaturaDe(conta.orgId)).currentPeriodEnd!;

    expect(depoisDoSegundo.getTime()).toBe(depoisDoPrimeiro.getTime());
    const liberacoes = await prisma.creditLedger.count({
      where: { subscriptionId: (await assinaturaDe(conta.orgId)).id, kind: "ASSINATURA", quantity: { gt: 0 } },
    });
    expect(liberacoes).toBe(1);
  });

  it("renovação antecipada preserva os dias que faltavam do ciclo pago", async () => {
    const conta = await criarConta("antecipada");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-ant1`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-ant`,
      }),
    );

    // Faltam 10 dias do ciclo, e a renovação já cai.
    const sub = await assinaturaDe(conta.orgId);
    const faltando = new Date(Date.now() + 10 * 86_400_000);
    await prisma.subscription.update({ where: { id: sub.id }, data: { currentPeriodEnd: faltando } });

    await processAsaasEvent(
      evento({
        event: "PAYMENT_RECEIVED",
        pagamento: `${PREFIXO}-pay-ant2`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-ant`,
      }),
    );

    const depois = await assinaturaDe(conta.orgId);
    // Os 10 dias restantes NÃO são apagados: o novo fim parte deles.
    expect(depois.currentPeriodEnd!.getTime()).toBeGreaterThan(faltando.getTime() + 25 * 86_400_000);
  });
});

describe("pacote de créditos avulso", () => {
  it("credita o pacote sobre a assinatura sem trocar o plano", async () => {
    const conta = await criarConta("pacote");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-pa1`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-pa1`,
      }),
    );

    await processAsaasEvent(
      evento({
        event: "PAYMENT_RECEIVED",
        pagamento: `${PREFIXO}-pay-pa2`,
        ref: refPacote(`${PREFIXO}-pacote-5`, conta.userId),
        valor: 74.9,
        forma: "PIX",
      }),
    );

    const sub = await assinaturaDe(conta.orgId);
    expect(sub.planId).toBe(planoEssencialId); // plano intacto
    expect(sub.extraAnalyses).toBe(5);

    const compra = await prisma.creditLedger.findFirstOrThrow({
      where: { subscriptionId: sub.id, kind: "COMPRA_ADICIONAL" },
    });
    expect(compra.expiresAt).toBeTruthy(); // validade própria do pacote
  });

  it("pacote reenviado não credita duas vezes", async () => {
    const conta = await criarConta("pacote2");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-pb1`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-pb1`,
      }),
    );
    const ev = evento({
      event: "PAYMENT_CONFIRMED",
      pagamento: `${PREFIXO}-pay-pb2`,
      ref: refPacote(`${PREFIXO}-pacote-5`, conta.userId),
      valor: 74.9,
      forma: "PIX",
    });
    await processAsaasEvent(ev);
    await processAsaasEvent(ev);

    const sub = await assinaturaDe(conta.orgId);
    expect(sub.extraAnalyses).toBe(5); // não 10
  });

  it("pacote comprado sem assinatura vira caso de suporte, não pagamento perdido", async () => {
    const conta = await criarConta("pacote3");
    const r = await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-pc1`,
        ref: refPacote(`${PREFIXO}-pacote-5`, conta.userId),
        valor: 74.9,
        forma: "PIX",
      }),
    );

    expect(r.action).toBe("ignorado");
    // Ver a observação do teste do upgrade: a prova é a quantia registrada.
    const registro = await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-pay-pc1` } });
    expect(registro?.status).toBe("PENDENTE");
    expect(registro?.amountCents).toBe(7490);
  });
});

/**
 * ── Pagar NÃO desfaz suspensão administrativa ────────────────────────────────
 *
 * SUSPENSA é gravada por uma via só: a ação do administrador no painel. É sanção sobre o
 * ACESSO — medida de uso aceitável, pendência em apuração —, não encerramento do contrato.
 * O pagamento reativava a conta sozinho, o que transformava a sanção em algo que o próprio
 * sancionado desfazia: bastava o débito do mês seguinte entrar.
 *
 * Decisão do dono do negócio. O dinheiro continua fazendo o que comprou — estende o
 * período e libera a cota —, porque suspensão bloqueia o uso e não confisca o que foi pago.
 */
describe("suspensão administrativa", () => {
  async function assinaturaSuspensa(conta: { userId: string; orgId: string }, ref: string) {
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-${ref}-1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `sub_${PREFIXO}_${ref}`,
      }),
    );
    const sub = await assinaturaDe(conta.orgId);
    // Estado que só a ação do administrador produz.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: "SUSPENSA", suspendedAt: new Date(), analysesUsed: 8 },
    });
    return sub;
  }

  it("a renovação paga NÃO reativa: o acesso segue bloqueado", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const conta = await criarConta("suspensa-renova");
    const sub = await assinaturaSuspensa(conta, "sr");

    const r = await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-sr-2`,
        valor: 119.9,
        assinatura: `sub_${PREFIXO}_sr`,
      }),
    );

    expect(r.action).toBe("aprovado");
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    // A sanção não é desfeita por quem foi sancionado.
    expect(depois.status).toBe("SUSPENSA");
    expect(depois.suspendedAt).not.toBeNull();
  });

  it("mas o dinheiro faz o que comprou: período estendido e cota liberada", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const conta = await criarConta("suspensa-periodo");
    const sub = await assinaturaSuspensa(conta, "sp");
    const fimAnterior = (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).currentPeriodEnd!;

    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-sp-2`,
        valor: 119.9,
        assinatura: `sub_${PREFIXO}_sp`,
      }),
    );

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    // Suspensão bloqueia o uso; não confisca o que foi pago.
    expect(depois.currentPeriodEnd!.getTime()).toBeGreaterThan(fimAnterior.getTime());
    expect(saldoDe(depois).total).toBe(8);
  });

  it("avisa a operação: cliente suspenso pagando não pode durar", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const conta = await criarConta("suspensa-alerta");
    await assinaturaSuspensa(conta, "sa");

    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-sa-2`,
        valor: 119.9,
        assinatura: `sub_${PREFIXO}_sa`,
      }),
    );

    const alerta = await prisma.securityEvent.findFirst({
      where: {
        type: "asaas_pagamento_de_assinatura_suspensa",
        metadata: { path: ["pagamento"], equals: `${PREFIXO}-pay-sa-2` },
      },
    });
    expect(alerta).not.toBeNull();
  });

  it("contratar de novo também NÃO desfaz a suspensão", async () => {
    // Um caminho de compra não pode ser a porta de saída de uma medida de uso aceitável.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const conta = await criarConta("suspensa-recontrata");
    const sub = await assinaturaSuspensa(conta, "sc");

    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-sc-2`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `sub_${PREFIXO}_sc_novo`,
      }),
    );

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(depois.status).toBe("SUSPENSA");
  });

  it("INADIMPLENTE continua sendo reativada pelo pagamento — é atraso, não sanção", async () => {
    /**
     * O contrapeso. Quem estava só atrasado e paga TEM de voltar: a inadimplência se
     * resolve pelo pagamento, e confundir os dois estados deixaria o cliente em dia
     * bloqueado.
     */
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const conta = await criarConta("inadimplente-volta");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-iv-1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `sub_${PREFIXO}_iv`,
      }),
    );
    const sub = await assinaturaDe(conta.orgId);
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: "INADIMPLENTE" } });

    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-iv-2`,
        valor: 119.9,
        assinatura: `sub_${PREFIXO}_iv`,
      }),
    );

    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("ATIVA");
  });
});

describe("atraso, estorno e cancelamento", () => {
  it("atraso suspende com prazo de tolerância, não corta na hora", async () => {
    const conta = await criarConta("atraso");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-at1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `${PREFIXO}-sub-at1`,
      }),
    );

    await processAsaasEvent(
      evento({
        event: "PAYMENT_OVERDUE",
        pagamento: `${PREFIXO}-pay-at2`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        assinatura: `${PREFIXO}-sub-at1`,
      }),
    );

    const sub = await assinaturaDe(conta.orgId);
    expect(sub.status).toBe("INADIMPLENTE");
    expect(sub.graceUntil).toBeTruthy();
    expect(sub.graceUntil!.getTime()).toBeGreaterThan(Date.now());
    // O saldo continua lá durante a tolerância.
    expect(saldoDe(sub).total).toBe(8);
  });

  it("estorno do CRÉDITO AVULSO não derruba a assinatura — retira só aquele saldo", async () => {
    /**
     * O achado mais desproporcional da auditoria do caminho do dinheiro: qualquer
     * estorno era tratado como estorno da ASSINATURA. A devolução de um crédito
     * avulso de R$ 5,00 marcava a conta como ESTORNADA, o login passava a ser
     * recusado e TODO o saldo do mês era bloqueado — um plano pago inteiro caía por
     * causa do reembolso de um crédito.
     */
    const conta = await criarConta("estorno-pacote");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-ep1`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-ep1`,
      }),
    );
    await processAsaasEvent(
      evento({
        event: "PAYMENT_RECEIVED",
        pagamento: `${PREFIXO}-pay-ep2`,
        ref: refPacote(`${PREFIXO}-pacote-5`, conta.userId),
        valor: 74.9,
        forma: "PIX",
      }),
    );
    const antes = await assinaturaDe(conta.orgId);
    expect(antes.extraAnalyses).toBe(5);
    const cotaAntes = antes.analysesQuota;

    // Estorno DAQUELE pagamento de crédito avulso.
    const r = await processAsaasEvent(
      evento({
        event: "PAYMENT_REFUNDED",
        pagamento: `${PREFIXO}-pay-ep2`,
        ref: refPacote(`${PREFIXO}-pacote-5`, conta.userId),
        valor: 74.9,
        forma: "PIX",
      }),
    );
    expect(r.action).toBe("estorno");

    const depois = await assinaturaDe(conta.orgId);
    // A assinatura sobrevive intacta: status, acesso e cota do mês.
    expect(depois.status).toBe("ATIVA");
    expect(depois.analysesQuota).toBe(cotaAntes);
    expect(depois.analysesUsed).toBe(0);
    // Só o saldo avulso volta.
    expect(depois.extraAnalyses).toBe(0);

    // Reenvio do evento não desconta de novo.
    await processAsaasEvent(
      evento({
        event: "PAYMENT_REFUNDED",
        pagamento: `${PREFIXO}-pay-ep2`,
        ref: refPacote(`${PREFIXO}-pacote-5`, conta.userId),
        valor: 74.9,
        forma: "PIX",
      }),
    );
    expect((await assinaturaDe(conta.orgId)).extraAnalyses).toBe(0);
  });

  it("estorno de crédito avulso já consumido não cobra de volta o serviço prestado", async () => {
    const conta = await criarConta("estorno-usado");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-eu1`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-eu1`,
      }),
    );
    await processAsaasEvent(
      evento({
        event: "PAYMENT_RECEIVED",
        pagamento: `${PREFIXO}-pay-eu2`,
        ref: refPacote(`${PREFIXO}-pacote-5`, conta.userId),
        valor: 74.9,
        forma: "PIX",
      }),
    );
    // O cliente já gastou 3 dos 5 avulsos.
    const sub = await assinaturaDe(conta.orgId);
    await prisma.subscription.update({ where: { id: sub.id }, data: { extraAnalyses: 2 } });

    await processAsaasEvent(
      evento({
        event: "PAYMENT_REFUNDED",
        pagamento: `${PREFIXO}-pay-eu2`,
        ref: refPacote(`${PREFIXO}-pacote-5`, conta.userId),
        valor: 74.9,
        forma: "PIX",
      }),
    );

    const depois = await assinaturaDe(conta.orgId);
    // Retira o que restava (2), não os 5 comprados: crédito consumido é análise
    // entregue, e retirá-la seria tomar de volta o serviço prestado.
    expect(depois.extraAnalyses).toBe(0);
    expect(depois.status).toBe("ATIVA");
  });

  it("estorno bloqueia o saldo não usado e encerra a assinatura", async () => {
    const conta = await criarConta("estorno");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-es1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `${PREFIXO}-sub-es1`,
      }),
    );

    await processAsaasEvent(
      evento({
        event: "PAYMENT_REFUNDED",
        pagamento: `${PREFIXO}-pay-es1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `${PREFIXO}-sub-es1`,
      }),
    );

    const sub = await assinaturaDe(conta.orgId);
    expect(sub.status).toBe("ESTORNADA");
    expect(saldoDe(sub).total).toBe(0);
    const bloqueio = await prisma.creditLedger.findFirst({
      where: { subscriptionId: sub.id, description: { contains: "bloqueados por estorno" } },
    });
    expect(bloqueio).toBeTruthy();
    const estornado = await prisma.payment.count({ where: { subscriptionId: sub.id, status: "ESTORNADO" } });
    expect(estornado).toBe(1);
  });

  /**
   * ── Devolução PARCIAL não é devolução total ──────────────────────────────────
   *
   * O evento de devolução parcial caía no mesmo caminho da total, e o efeito era
   * desproporcional ao ponto de ser absurdo: devolver R$ 10,00 de uma mensalidade de
   * R$ 119,90 — desconto de cortesia, ajuste de cobrança — punha a conta em ESTORNADA,
   * recusava o login, bloqueava toda a cota do mês e mandava ao cliente "assinatura
   * encerrada por estorno". Ele recebia dez reais e perdia o serviço que pagou.
   */
  it("devolução PARCIAL preserva assinatura, acesso e créditos", async () => {
    const conta = await criarConta("parcial");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-parcial`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `${PREFIXO}-sub-parcial`,
      }),
    );

    const r = await processAsaasEvent(
      evento({
        event: "PAYMENT_PARTIALLY_REFUNDED",
        pagamento: `${PREFIXO}-pay-parcial`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `${PREFIXO}-sub-parcial`,
      }),
    );

    expect(r.action).toBe("estorno");
    const sub = await assinaturaDe(conta.orgId);
    // Nada do que a devolução TOTAL faz: parte do valor continua paga, e o que ela
    // comprou continua entregue.
    expect(sub.status).toBe("ATIVA");
    expect(saldoDe(sub).total).toBe(8);
    expect(
      await prisma.creditLedger.count({
        where: { subscriptionId: sub.id, description: { contains: "bloqueados por estorno" } },
      }),
    ).toBe(0);
    // E fica registrado, porque quem devolveu parte precisa conferir o valor.
    const registro = await prisma.auditLog.findFirst({
      where: { action: "asaas.devolucao_parcial", entityId: sub.id },
    });
    expect(registro).not.toBeNull();
  });

  it("devolução parcial reenviada não registra nem alerta duas vezes", async () => {
    const conta = await criarConta("parcial2");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-parcial2`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `${PREFIXO}-sub-parcial2`,
      }),
    );
    const parcial = evento({
      event: "PAYMENT_PARTIALLY_REFUNDED",
      pagamento: `${PREFIXO}-pay-parcial2`,
      ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
      valor: 119.9,
      assinatura: `${PREFIXO}-sub-parcial2`,
    });

    await processAsaasEvent(parcial);
    await processAsaasEvent(parcial);

    const sub = await assinaturaDe(conta.orgId);
    // Alerta repetido é alerta ignorado, justamente no caso que depende de alguém olhar.
    expect(
      await prisma.auditLog.count({ where: { action: "asaas.devolucao_parcial", entityId: sub.id } }),
    ).toBe(1);
    expect(sub.status).toBe("ATIVA");
  });

  it("devolução PARCIAL de crédito avulso não retira o pacote inteiro", async () => {
    const conta = await criarConta("parcial-pacote");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-pp1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `${PREFIXO}-sub-pp1`,
      }),
    );
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-pp2`,
        ref: refPacote(`${PREFIXO}-pacote-5`, conta.userId),
        valor: 74.9,
      }),
    );
    expect(saldoDe(await assinaturaDe(conta.orgId)).total).toBe(13);

    await processAsaasEvent(
      evento({
        event: "PAYMENT_PARTIALLY_REFUNDED",
        pagamento: `${PREFIXO}-pay-pp2`,
        ref: refPacote(`${PREFIXO}-pacote-5`, conta.userId),
        valor: 74.9,
      }),
    );

    // A devolução parcial de um pacote de 5 retirava os 5 créditos.
    const sub = await assinaturaDe(conta.orgId);
    expect(saldoDe(sub).total).toBe(13);
    expect(sub.status).toBe("ATIVA");
  });

  /**
   * ── Cobrança AVULSA não derruba a assinatura ─────────────────────────────────
   *
   * Compra avulsa gera no Asaas uma cobrança SEPARADA, e os eventos dela chegavam ao
   * mesmo lugar que os da mensalidade. Efeito quando o cliente simplesmente desistia:
   * o PIX de R$ 5,00 abandonado vencia, e a mensalidade paga em dia virava INADIMPLENTE
   * — com prazo de tolerância aberto, e-mail de "pagamento atrasado" e encerramento pela
   * manutenção diária. Não pagar o que é opcional derrubava o que já estava pago.
   */
  it("PIX de crédito avulso abandonado NÃO deixa a assinatura inadimplente", async () => {
    const conta = await criarConta("avulso-vencido");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-av1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `${PREFIXO}-sub-av1`,
      }),
    );

    const r = await processAsaasEvent(
      evento({
        event: "PAYMENT_OVERDUE",
        pagamento: `${PREFIXO}-pay-av2`,
        ref: refPacote(`${PREFIXO}-pacote-5`, conta.userId),
        valor: 74.9,
        forma: "PIX",
      }),
    );

    expect(r.action).toBe("ignorado");
    const sub = await assinaturaDe(conta.orgId);
    expect(sub.status).toBe("ATIVA");
    // Nem tolerância aberta: `graceUntil` é o relógio do encerramento por inadimplência.
    expect(sub.graceUntil).toBeNull();
    expect(saldoDe(sub).total).toBe(8);
  });

  it("apagar no Asaas a cobrança avulsa não paga NÃO cancela a assinatura", async () => {
    const conta = await criarConta("avulso-apagado");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-av3`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `${PREFIXO}-sub-av3`,
      }),
    );

    const r = await processAsaasEvent(
      evento({
        event: "PAYMENT_DELETED",
        pagamento: `${PREFIXO}-pay-av4`,
        ref: refPacote(`${PREFIXO}-pacote-5`, conta.userId),
        valor: 74.9,
      }),
    );

    expect(r.action).toBe("ignorado");
    const sub = await assinaturaDe(conta.orgId);
    // Arrumar a lista de cobranças no painel derrubava um contrato ativo.
    expect(sub.status).toBe("ATIVA");
    expect(sub.canceledAt).toBeNull();
  });

  it("devolver a diferença de UPGRADE não encerra a assinatura", async () => {
    const conta = await criarConta("upgrade-estornado");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-up-e1`,
        ref: refPlano(`${PREFIXO}-essencial`, conta.userId),
        valor: 39.9,
        assinatura: `${PREFIXO}-sub-up-e1`,
      }),
    );
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-up-e2`,
        ref: refUpgrade(`${PREFIXO}-profissional`, conta.userId),
        valor: 40,
        forma: "PIX",
      }),
    );
    const depoisDoUpgrade = await assinaturaDe(conta.orgId);
    expect(depoisDoUpgrade.planId).toBe(planoProfId);

    const r = await processAsaasEvent(
      evento({
        event: "PAYMENT_REFUNDED",
        pagamento: `${PREFIXO}-pay-up-e2`,
        ref: refUpgrade(`${PREFIXO}-profissional`, conta.userId),
        valor: 40,
        forma: "PIX",
      }),
    );

    expect(r.action).toBe("estorno");
    const sub = await assinaturaDe(conta.orgId);
    // Devolver R$ 40,00 de proporcional derrubava o plano inteiro: conta ESTORNADA,
    // login recusado, saldo todo bloqueado.
    expect(sub.status).toBe("ATIVA");
    expect(saldoDe(sub).total).toBeGreaterThan(0);
    const registro = await prisma.auditLog.findFirst({
      where: { action: "asaas.estorno_de_upgrade", entityId: sub.id },
    });
    expect(registro).not.toBeNull();
  });

  /**
   * ── Estorno tem de PARAR A COBRANÇA ──────────────────────────────────────────
   *
   * A assinatura era marcada ESTORNADA, o acesso caía, os créditos eram bloqueados — e a
   * recorrência seguia viva no Asaas, debitando o cartão todo mês. O cliente ficava
   * pagando por um serviço que não conseguia nem abrir, exatamente depois de o dinheiro
   * ter sido devolvido a ele (ou de ele ter contestado a cobrança).
   *
   * No chargeback é pior: insistir na cobrança de quem já contestou é o caminho mais
   * curto para novas contestações. E a Política §6 publica que a assinatura é ENCERRADA
   * por estorno — encerrada e cobrando é contradição, não interpretação.
   */
  it("estorno encerra a recorrência no Asaas", async () => {
    const chamadas: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      chamadas.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const conta = await criarConta("estorno-cobranca");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-ec1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `sub_${PREFIXO}_ec1`,
      }),
    );

    await processAsaasEvent(
      evento({
        event: "PAYMENT_REFUNDED",
        pagamento: `${PREFIXO}-pay-ec1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `sub_${PREFIXO}_ec1`,
      }),
    );

    const sub = await assinaturaDe(conta.orgId);
    expect(sub.status).toBe("ESTORNADA");
    // Sem esta chamada, a conta fica bloqueada E sendo debitada todo mês.
    expect(chamadas.some((c) => c.startsWith("DELETE") && c.includes(`sub_${PREFIXO}_ec1`))).toBe(true);
  });

  it("chargeback também interrompe a cobrança", async () => {
    const chamadas: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      chamadas.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const conta = await criarConta("chargeback");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-cb1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `sub_${PREFIXO}_cb1`,
      }),
    );

    await processAsaasEvent(
      evento({
        event: "PAYMENT_CHARGEBACK_REQUESTED",
        pagamento: `${PREFIXO}-pay-cb1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `sub_${PREFIXO}_cb1`,
      }),
    );

    expect(chamadas.some((c) => c.startsWith("DELETE") && c.includes(`sub_${PREFIXO}_cb1`))).toBe(true);
  });

  it("falha ao interromper vira ALERTA: cliente bloqueado e sendo cobrado", async () => {
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (String(init?.method) === "DELETE") {
        return new Response(JSON.stringify({ errors: [{ description: "Serviço indisponível" }] }), { status: 503 });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const conta = await criarConta("estorno-falha");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-ef1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `sub_${PREFIXO}_ef1`,
      }),
    );
    await processAsaasEvent(
      evento({
        event: "PAYMENT_REFUNDED",
        pagamento: `${PREFIXO}-pay-ef1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `sub_${PREFIXO}_ef1`,
      }),
    );

    // O estorno se conclui de qualquer forma — mas alguém precisa saber que a cobrança
    // continua viva numa conta bloqueada. Isso não se conserta sozinho.
    const alerta = await prisma.securityEvent.findFirst({
      where: { type: "asaas_estorno_com_cobranca_ativa" },
      orderBy: { createdAt: "desc" },
    });
    expect(alerta).not.toBeNull();
    expect((await assinaturaDe(conta.orgId)).status).toBe("ESTORNADA");
  });

  it("estorno reenviado não cria segundo bloqueio", async () => {
    const conta = await criarConta("estorno2");
    const base = {
      pagamento: `${PREFIXO}-pay-es2`,
      ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
      valor: 119.9,
      assinatura: `${PREFIXO}-sub-es2`,
    };
    await processAsaasEvent(evento({ ...base, event: "PAYMENT_CONFIRMED" }));
    await processAsaasEvent(evento({ ...base, event: "PAYMENT_REFUNDED" }));
    await processAsaasEvent(evento({ ...base, event: "PAYMENT_REFUNDED" }));

    const sub = await assinaturaDe(conta.orgId);
    const bloqueios = await prisma.creditLedger.count({
      where: { subscriptionId: sub.id, description: { contains: "bloqueados por estorno" } },
    });
    expect(bloqueios).toBe(1);
    const estornados = await prisma.payment.count({ where: { subscriptionId: sub.id, status: "ESTORNADO" } });
    expect(estornados).toBe(1);
  });

  it("cancelamento mantém o acesso até o fim do período pago", async () => {
    const conta = await criarConta("cancela");
    await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-ca1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        valor: 119.9,
        assinatura: `${PREFIXO}-sub-ca1`,
      }),
    );

    await processAsaasEvent(
      evento({
        event: "PAYMENT_DELETED",
        pagamento: `${PREFIXO}-pay-ca1`,
        ref: refPlano(`${PREFIXO}-profissional`, conta.userId),
        assinatura: `${PREFIXO}-sub-ca1`,
      }),
    );

    const sub = await assinaturaDe(conta.orgId);
    expect(sub.status).toBe("CANCELADA");
    expect(sub.canceledAt).toBeTruthy();
    // Não zera o saldo: o mês foi pago.
    expect(saldoDe(sub).total).toBe(8);
    expect(sub.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("recusa de evento inválido", () => {
  it("ignora evento sem pagamento", async () => {
    const r = await processAsaasEvent({ event: "PAYMENT_CONFIRMED" });
    expect(r.action).toBe("ignorado");
  });

  /**
   * "Ignorar" aqui nunca significou descartar o dinheiro — e passou a não significar
   * mesmo. A conta do `externalReference` não existe, então não há a quem liberar
   * acesso; a quantia é gravada como PENDENTE, sem assinatura, e a operação é
   * avisada. Ver `dinheiroSemDestino`, em src/lib/asaas.ts.
   */
  it("conta inexistente: não libera acesso, mas a quantia fica registrada", async () => {
    const r = await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-fantasma`,
        ref: refPlano(`${PREFIXO}-profissional`, "usuario-que-nao-existe"),
        valor: 119.9,
      }),
    );
    expect(r.action).toBe("ignorado");

    const registro = await prisma.payment.findFirst({ where: { externalId: `${PREFIXO}-pay-fantasma` } });
    expect(registro?.status).toBe("PENDENTE");
    expect(registro?.subscriptionId).toBeNull();
    expect(registro?.amountCents).toBe(11990);
  });

  it("ignora evento de plano inexistente sem criar assinatura", async () => {
    const conta = await criarConta("planofalso");
    const r = await processAsaasEvent(
      evento({
        event: "PAYMENT_CONFIRMED",
        pagamento: `${PREFIXO}-pay-pf`,
        ref: refPlano(`${PREFIXO}-plano-que-nao-existe`, conta.userId),
        valor: 119.9,
      }),
    );
    expect(r.action).toBe("ignorado");
    const subs = await prisma.subscription.count({ where: { organizationId: conta.orgId } });
    expect(subs).toBe(0);
  });

  it("ignora tipo de evento não mapeado", async () => {
    const r = await processAsaasEvent(
      evento({ event: "PAYMENT_ANTICIPATED", pagamento: `${PREFIXO}-pay-outro`, valor: 10 }),
    );
    expect(r.action).toBe("ignorado");
  });
});
