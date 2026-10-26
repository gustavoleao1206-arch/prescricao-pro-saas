import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Liberação mensal do plano ANUAL.
 *
 * O cliente paga R$ 419,00 uma vez pela oferta de "20 análises por mês". A
 * recorrência do Asaas é anual: chega UM evento de pagamento por ano, e nenhum
 * quando o anual é pago por PIX. Sem esta rotina, o assinante recebia 20 créditos e
 * ficava sem serviço a partir do segundo mês — defeito invisível enquanto a oferta
 * era ilimitada, porque cota 0 libera sempre.
 *
 * O que os testes travam, e cada um vale dinheiro nas duas direções:
 *  1. o anual RECEBE a cota de cada mês;
 *  2. recebe UMA vez por mês, não duas;
 *  3. só a partir do DIA DO CONTRATO — senão um contrato de 12 meses que atravessa
 *     13 meses civis ganharia uma cota de brinde por ano;
 *  4. o plano MENSAL não é tocado — a cota dele vem do pagamento, e adiantar daria
 *     crédito grátis e engoliria a liberação legítima pela chave do mês.
 */

const { liberarCiclosAnuais } = await import("../src/lib/ciclo-anual");
const { saldoDe, chaveDoCiclo } = await import("../src/lib/credits");

const prisma = new PrismaClient();
const PREFIXO = "test-anual";

let orgId = "";
let planoAnualId = "";
let planoMensalId = "";

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orgs = await prisma.organization.findMany({
    where: { OR: [{ name: { startsWith: PREFIXO } }, { ownerId: { in: ids } }] },
    select: { id: true },
  });
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.securityEvent.deleteMany({ where: { type: "ciclo_anual_nao_liberado" } });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

/** Assinatura ativa, com o contrato começando na data informada. */
async function assinatura(planId: string, inicio: Date, cota = 20) {
  return prisma.subscription.create({
    data: {
      organizationId: orgId,
      planId,
      status: "ATIVA",
      provider: "ASAAS",
      amountCents: 41900,
      analysesQuota: cota,
      analysesUsed: 0,
      startedAt: inicio,
      currentPeriodEnd: new Date(inicio.getTime() + 365 * 86_400_000),
    },
  });
}

beforeAll(async () => {
  await limpar();
  const anual = await prisma.plan.create({
    data: { slug: `${PREFIXO}-anual`, name: "Anual", priceCents: 41900, period: "ANUAL", monthlyAnalyses: 20, maxUsers: 1 },
  });
  const mensal = await prisma.plan.create({
    data: { slug: `${PREFIXO}-mensal`, name: "Mensal", priceCents: 4990, period: "MENSAL", monthlyAnalyses: 20, maxUsers: 1 },
  });
  planoAnualId = anual.id;
  planoMensalId = mensal.id;
});

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

beforeEach(async () => {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orgs = await prisma.organization.findMany({ where: { ownerId: { in: ids } }, select: { id: true } });
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });

  const user = await prisma.user.create({
    data: { email: `${PREFIXO}-cliente@exemplo.local`, name: "Cliente Anual", role: "CLIENTE", status: "ATIVO" },
  });
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org`, ownerId: user.id } });
  orgId = org.id;
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id, orgRole: "OWNER" } });
});

describe("cota mensal do plano anual", () => {
  it("libera a cota do mês corrente depois do dia do contrato", async () => {
    // Contrato em 10/08/2026; hoje, no teste, 20/09/2026 — segundo mês do contrato.
    const sub = await assinatura(planoAnualId, new Date("2026-08-10T12:00:00.000Z"));
    // O cliente gastou tudo no primeiro mês.
    await prisma.subscription.update({ where: { id: sub.id }, data: { analysesUsed: 20 } });

    const r = await liberarCiclosAnuais(new Date("2026-09-20T09:00:00.000Z"));
    /**
     * Afirma sobre ESTA assinatura, e não sobre o total da varredura: a rotina percorre
     * todas as anuais do banco, e a suíte roda os arquivos em paralelo sobre o mesmo
     * Postgres. Contar o total fazia o teste falhar por causa de fixture de outro arquivo.
     */
    expect(r.detalhes.some((d) => d.subscriptionId === sub.id)).toBe(true);

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(saldoDe(depois).total).toBe(20);
    expect(depois.analysesUsed).toBe(0);
  });

  it("não libera antes do dia do contrato — senão 12 meses pagos rendem 13 cotas", async () => {
    /**
     * Contrato em 20/08 vale até 19/08 do ano seguinte: doze meses PAGOS que tocam
     * TREZE meses civis. Como a idempotência é por mês civil, liberar no dia 1º daria
     * uma cota de brinde por contrato, todo ano.
     */
    const sub = await assinatura(planoAnualId, new Date("2026-08-20T12:00:00.000Z"));

    // Sempre por assinatura, nunca pelo total: a varredura é global e a suíte roda em
    // paralelo sobre o mesmo banco.
    const antes = await liberarCiclosAnuais(new Date("2026-09-05T09:00:00.000Z"));
    expect(antes.detalhes.some((d) => d.subscriptionId === sub.id)).toBe(false);
    expect(antes.aguardando).toBeGreaterThanOrEqual(1);

    const depois = await liberarCiclosAnuais(new Date("2026-09-20T09:00:00.000Z"));
    expect(depois.detalhes.some((d) => d.subscriptionId === sub.id)).toBe(true);
  });

  it("dia 31 não some em mês curto: cai no último dia", async () => {
    // Contrato em 31/01. Fevereiro não tem dia 31 — a âncora vira 28.
    const sub = await assinatura(planoAnualId, new Date("2026-01-31T12:00:00.000Z"));

    const r = await liberarCiclosAnuais(new Date("2026-02-28T09:00:00.000Z"));
    expect(
      r.detalhes.some((d) => d.subscriptionId === sub.id),
      "o mês de 28 dias ficou sem cota",
    ).toBe(true);
  });

  it("rodar duas vezes no mesmo mês não libera duas cotas", async () => {
    const sub = await assinatura(planoAnualId, new Date("2026-08-10T12:00:00.000Z"));

    const primeira = await liberarCiclosAnuais(new Date("2026-09-20T09:00:00.000Z"));
    const segunda = await liberarCiclosAnuais(new Date("2026-09-21T09:00:00.000Z"));
    expect(primeira.detalhes.some((d) => d.subscriptionId === sub.id)).toBe(true);
    expect(segunda.detalhes.some((d) => d.subscriptionId === sub.id)).toBe(false);

    const lancamentos = await prisma.creditLedger.count({
      where: { subscriptionId: sub.id, kind: "ASSINATURA", idempotencyKey: `ciclo:${sub.id}:${chaveDoCiclo(new Date("2026-09-20T09:00:00.000Z"))}` },
    });
    expect(lancamentos).toBe(1);
  });

  it("NÃO toca no plano mensal — a cota dele vem do pagamento", async () => {
    /**
     * Este é o teste que impede o defeito inverso. O mensal que paga dia 20 receberia
     * cota nova no dia 1º (dezenove dias de graça) e, pior, a liberação legítima do
     * webhook no dia 20 seria ignorada, porque a chave daquele mês já teria sido
     * gasta: o ciclo do cliente migraria de vez para o dia 1º.
     */
    const sub = await assinatura(planoMensalId, new Date("2026-08-20T12:00:00.000Z"));
    await prisma.subscription.update({ where: { id: sub.id }, data: { analysesUsed: 20 } });

    const r = await liberarCiclosAnuais(new Date("2026-09-25T09:00:00.000Z"));
    /**
     * A afirmação é sobre ESTA assinatura, não sobre o total da varredura.
     *
     * `liberarCiclosAnuais` percorre todas as assinaturas anuais do banco, e a suíte
     * roda os arquivos em paralelo sobre o mesmo Postgres: outro arquivo com uma
     * assinatura anual ativa fazia `liberadas` subir e este teste falhar por motivo
     * alheio ao que ele mede. O que importa é que a assinatura MENSAL não foi tocada.
     */
    expect(r.detalhes.some((d) => d.subscriptionId === sub.id)).toBe(false);

    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(saldoDe(depois).total).toBe(0);
  });

  it("plano legado ILIMITADO (cota 0) é ignorado", async () => {
    const legado = await prisma.plan.create({
      data: { slug: `${PREFIXO}-legado`, name: "Legado", priceCents: 41900, period: "ANUAL", monthlyAnalyses: 0, maxUsers: 1 },
    });
    const sub = await assinatura(legado.id, new Date("2026-08-10T12:00:00.000Z"), 0);

    const r = await liberarCiclosAnuais(new Date("2026-09-20T09:00:00.000Z"));
    expect(r.detalhes.some((d) => d.subscriptionId === sub.id)).toBe(false);
    // Segue ilimitado, sem lançamento nenhum.
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(saldoDe(depois).ilimitado).toBe(true);
  });

  it("assinatura com período já vencido não recebe cota", async () => {
    const sub = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId: planoAnualId,
        status: "ATIVA",
        provider: "ASAAS",
        amountCents: 41900,
        analysesQuota: 20,
        analysesUsed: 20,
        startedAt: new Date("2025-08-10T12:00:00.000Z"),
        // Período pago terminou.
        currentPeriodEnd: new Date("2026-08-09T12:00:00.000Z"),
      },
    });

    const r = await liberarCiclosAnuais(new Date("2026-09-20T09:00:00.000Z"));
    expect(r.detalhes.some((d) => d.subscriptionId === sub.id)).toBe(false);
    const depois = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(saldoDe(depois).total).toBe(0);
  });
});
