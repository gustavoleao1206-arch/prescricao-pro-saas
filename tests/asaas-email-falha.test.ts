import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Falha do provedor de e-mail não pode invalidar um pagamento que entrou.
 *
 * Este arquivo substitui `tests/hotmart-email-falha.test.ts`, apagado junto com a
 * integração da Hotmart. O comportamento protegido é o mesmo e vale para o
 * gateway que está em uso: o aviso ao cliente é a ÚLTIMA etapa da aprovação,
 * depois de assinatura, pagamento e créditos já gravados. Se uma queda do
 * provedor de e-mail derrubasse a função, o webhook devolveria erro para uma
 * compra processada por inteiro, o Asaas reenviaria e — esgotadas as tentativas —
 * sobraria um cliente que pagou, com saldo, e um registro que ninguém revisa.
 *
 * O e-mail é conveniência; o acesso é a obrigação. Aqui se verifica essa ordem de
 * prioridade e que a falha do aviso deixa rastro em vez de desaparecer.
 *
 * Fica em arquivo próprio porque `vi.mock` vale para o módulo inteiro: os outros
 * testes do Asaas precisam do caminho de e-mail real (driver "console").
 */

const MOTIVO = "provedor de e-mail fora do ar (simulado)";

vi.mock("../src/lib/subscription-emails", () => ({
  sendActivated: vi.fn(async () => {
    throw new Error(MOTIVO);
  }),
  sendWelcomeCreatePassword: vi.fn(async () => {}),
  sendReactivated: vi.fn(async () => {}),
  sendRenewalConfirmed: vi.fn(async () => {}),
  sendPaymentLate: vi.fn(async () => {}),
  sendCanceled: vi.fn(async () => {}),
  sendRefunded: vi.fn(async () => {}),
}));

const { processAsaasEvent } = await import("../src/lib/asaas");
const { saldoDe } = await import("../src/lib/credits");

const prisma = new PrismaClient();
const PREFIXO = "test-asemail";
const EMAIL = `${PREFIXO}-cliente@exemplo.local`;
const PAGAMENTO = `${PREFIXO}-pay-1`;

let userId = "";
let orgId = "";

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orgs = await prisma.organization.findMany({
    where: { OR: [{ name: { startsWith: PREFIXO } }, { ownerId: { in: ids } }] },
    select: { id: true },
  });
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  /**
   * Pagamento tem de sair pelo `externalId`, não pela cascata.
   *
   * `Payment.subscriptionId` é opcional e a relação não é cascata: apagar a
   * assinatura só põe a coluna em NULL e a linha fica. Como a deduplicação de
   * pagamento é GLOBAL por `externalId`, um órfão de execução anterior faria
   * `handleAprovado` tratar este evento como repetido e PULAR o e-mail — o teste
   * passaria a falhar sozinho na segunda execução, sem nada ter mudado no código.
   */
  await prisma.payment.deleteMany({ where: { externalId: { startsWith: PREFIXO } } });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

beforeAll(async () => {
  await limpar();
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-plano`,
      name: "Plano Teste E-mail Asaas",
      priceCents: 11990,
      period: "MENSAL",
      monthlyAnalyses: 8,
      maxUsers: 1,
    },
  });

  // No fluxo do Asaas o cliente já tem conta: ele se cadastra e depois paga.
  const user = await prisma.user.create({
    data: { email: EMAIL, name: "Cliente Sem Aviso", role: "CLIENTE", status: "ATIVO", emailVerifiedAt: new Date() },
  });
  userId = user.id;
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org`, ownerId: user.id } });
  orgId = org.id;
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id, orgRole: "OWNER" } });

  // Guarda o slug do plano para o evento montado no teste.
  process.env.PTP_TESTE_PLANO = plano.slug;
});

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

describe("falha no e-mail de aprovação", () => {
  it("conclui o pagamento, mantém o acesso e reporta a falha do aviso", async () => {
    const resultado = await processAsaasEvent({
      event: "PAYMENT_CONFIRMED",
      payment: {
        id: PAGAMENTO,
        customer: `cus_${PREFIXO}`,
        subscription: `${PREFIXO}-sub-1`,
        value: 119.9,
        billingType: "CREDIT_CARD",
        status: "CONFIRMED",
        externalReference: `plano:${process.env.PTP_TESTE_PLANO}:user:${userId}`,
      },
    });

    // 1) Não lançou: o webhook responde sucesso para um pagamento que de fato
    //    entrou por inteiro. Se lançasse, o Asaas reenviaria até desistir.
    expect(resultado.action).toBe("aprovado");
    // A falha do aviso é reportada, não escondida.
    expect(resultado.message).toContain(MOTIVO);

    // 2) O acesso existe de verdade, com os créditos do ciclo.
    const sub = await prisma.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(sub.status).toBe("ATIVA");
    expect(sub.provider).toBe("ASAAS");
    expect(saldoDe(sub).total).toBe(8);

    // 3) O pagamento está registrado — é receita que precisa aparecer no caixa.
    const pago = await prisma.payment.count({ where: { subscriptionId: sub.id, status: "APROVADO" } });
    expect(pago).toBe(1);

    // 4) Sobra rastro para alguém agir sobre o aviso que não saiu.
    const alerta = await prisma.auditLog.findFirst({
      where: { action: "asaas.email.failed", entityId: userId },
    });
    expect(alerta).toBeTruthy();
  });
});
