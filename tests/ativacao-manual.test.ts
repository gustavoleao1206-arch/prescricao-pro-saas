import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Liberação manual de acesso — vendas que não passam pelo gateway.
 *
 * ── Por que este arquivo passou a existir ─────────────────────────────────────
 * A ativação manual não tinha teste NENHUM, e é um caminho de dinheiro: ela concede
 * acesso pago, cria conta, cria assinatura e solta créditos. É a rede de segurança de
 * quando o webhook falha — o cliente pagou de verdade e o dono precisa liberar à mão — e
 * a única porta para venda por transferência, contrato empresarial e plano sob consulta.
 *
 * ── O que estava errado ───────────────────────────────────────────────────────
 * Ela gravava `nextRenewalAt`, e esse campo significa uma coisa só em toda a aplicação:
 * "esta assinatura se cobra sozinha". MANUAL é o contrário — a venda aconteceu fora do
 * gateway, não existe mandato de débito, nada cobra de novo. O campo preenchido mentia em
 * três lugares: na tela do cliente ("Próxima cobrança", "renovação automática"), na rota
 * do boleto (que recusava o cliente manual alegando cobrança dupla, quando o docblock
 * dela nomeia a liberação manual como caso seguro) e no MRR — este o pior, porque
 * `encerrarAssinaturasVencidas` só encerra quem tem `nextRenewalAt` nulo, deixando em paz
 * quem tem data porque "quem decide o fim dela é o gateway". MANUAL tem data e não tem
 * gateway: ficava ATIVA para sempre, somando receita recorrente de quem nunca vai pagar
 * de novo.
 *
 * E não apagava `canceledByRequestAt`, a marca imutável de "mandei parar de cobrar" —
 * campo criado junto com a garantia anti-ressurreição, em que só a ativação pelo Asaas
 * foi atualizada.
 */

// 32 bytes exatos, exigência de `src/lib/crypto.ts`. Ver a nota em
// tests/boleto-rota.test.ts: o valor antigo dava 48 bytes e só não quebrava
// aqui porque este arquivo não chega a criptografar documento.
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");

const { ativarAssinaturaManual } = await import("../src/lib/ativacao-manual");
const { encerrarAssinaturasVencidas } = await import("../src/lib/mudanca-plano");
const { renovacaoDe } = await import("../src/lib/renovacao");

const prisma = new PrismaClient();
const PREFIXO = "test-manual";
const ALERTA_COBRANCA_DUPLA = "ativacao_manual_com_cobranca_automatica";

let planoId = "";
let atorId = "";

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orgs = await prisma.organization.findMany({
    where: { OR: [{ name: { startsWith: PREFIXO } }, { ownerId: { in: ids } }] },
    select: { id: true },
  });
  if (orgs.length) {
    const subs = await prisma.subscription.findMany({
      where: { organizationId: { in: orgs.map((o) => o.id) } },
      select: { id: true },
    });
    // Pagamento NÃO cascateia com a assinatura: sem isto sobra órfão a cada rodada.
    if (subs.length) await prisma.payment.deleteMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: subs.map((s) => s.id) } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
  }
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
  /**
   * O alerta grava um evento de segurança, e ele não cai por cascata nenhuma. Só esta
   * ativação produz este tipo, então apagar por tipo é preciso — e sobra entre execuções
   * seria o começo de um teste que passa medindo a rodada anterior.
   */
  await prisma.securityEvent.deleteMany({ where: { type: ALERTA_COBRANCA_DUPLA } });
}

beforeAll(async () => {
  await limpar();
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-mensal`,
      name: "Mensal (venda manual)",
      priceCents: 4990,
      period: "MENSAL",
      monthlyAnalyses: 20,
      maxUsers: 1,
    },
  });
  planoId = plano.id;
});

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

let clienteId = "";

beforeEach(async () => {
  await limpar();
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-mensal`,
      name: "Mensal (venda manual)",
      priceCents: 4990,
      period: "MENSAL",
      monthlyAnalyses: 20,
      maxUsers: 1,
    },
  });
  planoId = plano.id;

  const ator = await prisma.user.create({
    data: { email: `${PREFIXO}-dono@exemplo.local`, name: "Dono", passwordHash: "x", role: "ADMIN" },
  });
  atorId = ator.id;

  /**
   * A conta já existe de propósito: com conta nova a função envia o convite de criação
   * de senha, e teste de regra de cobrança não deve depender de e-mail saindo.
   */
  const cliente = await prisma.user.create({
    data: { email: `${PREFIXO}-cliente@exemplo.local`, name: "Cliente Manual", passwordHash: "x", role: "CLIENTE" },
  });
  clienteId = cliente.id;
});

function ativar() {
  return ativarAssinaturaManual(
    {
      email: `${PREFIXO}-cliente@exemplo.local`,
      planoSlug: `${PREFIXO}-mensal`,
      metodo: "transferencia",
      motivo: "Venda por transferência bancária",
      enviarConvite: false,
    },
    { id: atorId },
  );
}

describe("venda manual não se cobra sozinha", () => {
  it("não grava promessa de renovação", async () => {
    const r = await ativar();

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: r.subscriptionId } });
    expect(sub.status).toBe("ATIVA");
    expect(sub.provider).toBe("MANUAL");
    /**
     * O campo é o sinal de "se cobra sozinha" em toda a aplicação. Preenchido aqui, ele
     * prometia ao cliente uma renovação que nada no sistema pode executar.
     */
    expect(sub.nextRenewalAt).toBeNull();
    // O ciclo pago existe e continua valendo: o que não existe é a cobrança seguinte.
    expect(sub.currentPeriodEnd).not.toBeNull();
    expect(r.creditosLiberados).toBe(20);
  });

  it("a tela do cliente diz 'Acesso até', e não 'Próxima cobrança'", async () => {
    const r = await ativar();
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: r.subscriptionId } });

    // `renovacaoDe` é o vocabulário único das telas — a asserção é sobre o que se lê.
    const renovacao = renovacaoDe(sub);
    expect(renovacao.modo).toBe("ciclo-unico");
    expect(renovacao.rotuloDaData).toBe("Acesso até");
    expect(renovacao.formaDeCobranca).toBe("pagamento único, sem renovação");
    expect(renovacao.temProximoCiclo).toBe(false);
  });

  /**
   * ⚠️ O defeito mais caro dos três, porque é silencioso: não afeta acesso nenhum, só o
   * número pelo qual o dono conduz o negócio.
   */
  it("vencida, é encerrada pela varredura diária — o MRR deixa de contá-la", async () => {
    const r = await ativar();

    // O ciclo pago terminou ontem.
    await prisma.subscription.update({
      where: { id: r.subscriptionId },
      data: { currentPeriodEnd: new Date(Date.now() - 86_400_000) },
    });

    await encerrarAssinaturasVencidas();

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: r.subscriptionId } });
    /**
     * Com `nextRenewalAt` preenchido ela era invisível para a varredura — o filtro exige
     * o campo NULO, porque assinatura com data de renovação é de cartão e quem decide o
     * fim dela é o gateway. MANUAL não tem gateway, então ficava ATIVA para sempre.
     */
    expect(sub.status).toBe("VENCIDA");

    // E o MRR soma pelo status: enquanto era ATIVA, contava receita de quem não paga mais.
    const mrr = await prisma.subscription.aggregate({
      where: { status: "ATIVA", organizationId: sub.organizationId },
      _sum: { amountCents: true },
    });
    expect(mrr._sum.amountCents ?? 0).toBe(0);
  });
});

describe("cliente que cancelou e comprou de novo por fora", () => {
  it("o pedido de parada é apagado — a compra nova não nasce descrita como cancelada", async () => {
    const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org`, ownerId: clienteId } });
    await prisma.user.update({ where: { id: clienteId }, data: { organizationId: org.id, orgRole: "OWNER" } });
    const antes = new Date(Date.now() - 10 * 86_400_000);
    const cancelada = await prisma.subscription.create({
      data: {
        organizationId: org.id,
        planId: planoId,
        status: "CANCELADA",
        provider: "ASAAS",
        externalRef: "sub_test_manual_antiga",
        amountCents: 4990,
        canceledAt: antes,
        canceledReason: "Cancelamento solicitado pelo cliente",
        // A marca imutável do pedido de parada.
        canceledByRequestAt: antes,
        currentPeriodEnd: antes,
        maxUsers: 1,
        analysesQuota: 20,
      },
    });

    const r = await ativar();
    // Atualiza a MESMA assinatura, não cria outra.
    expect(r.subscriptionId).toBe(cancelada.id);

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: r.subscriptionId } });
    expect(sub.status).toBe("ATIVA");
    /**
     * A regra está escrita em `canceladaAPedido`: nada além de uma contratação NOVA apaga
     * o pedido de parada. Liberação manual é contratação nova — o dono está atestando uma
     * venda.
     */
    expect(sub.canceledByRequestAt).toBeNull();
    expect(sub.canceledAt).toBeNull();

    /**
     * O efeito visível: `renovacaoDe` lê o pedido de parada ANTES de qualquer outra coisa,
     * então a assinatura recém-paga era descrita como "cancelada — não haverá novas
     * cobranças". E a tela esconde o botão de cancelar quando o campo está preenchido:
     * assinatura paga, sem saída dentro do produto.
     */
    expect(renovacaoDe(sub).modo).not.toBe("encerrando");
    expect(renovacaoDe(sub).formaDeCobranca).not.toContain("cancelada");
  });

  it("liberar duas vezes não cria uma segunda assinatura para a mesma organização", async () => {
    /**
     * Duas assinaturas na mesma organização partiriam os dados do cliente em dois lugares
     * e quebrariam toda busca que resolve por "a mais recente da conta" — que é como o
     * webhook do provedor encontra o contrato.
     */
    const primeira = await ativar();
    const segunda = await ativar();

    expect(segunda.subscriptionId).toBe(primeira.subscriptionId);
    const org = await prisma.organization.findFirstOrThrow({ where: { ownerId: clienteId } });
    expect(await prisma.subscription.count({ where: { organizationId: org.id } })).toBe(1);
  });
});

/**
 * Liberar à mão para quem JÁ tem cobrança automática no provedor.
 *
 * ── A decisão, e por que não é bloquear ───────────────────────────────────────
 * Este é o único caminho em que duas cobranças pelo mesmo acesso podem conviver sem que
 * nada tenha dado errado, porque a liberação manual serve a dois propósitos opostos: pode
 * estar SUBSTITUINDO a cobrança do provedor (a venda passou a ser por fora) ou apenas
 * COBRINDO uma falha de webhook na cobrança dele. As duas hipóteses pedem ações contrárias.
 *
 * Bloquear a liberação foi descartado: na segunda hipótese o cliente pagou por cartão,
 * está fora do ar, e esta função é o remédio — recusar ali transformaria "pagou e não
 * liberou" em "pagou, não liberou, e o remédio se recusa a agir". Encerrar a recorrência
 * sozinho foi descartado pelo mesmo motivo, ao contrário: ela é legítima e está pagando.
 *
 * Sobra liberar e contar, na hora, para quem sabe qual das duas hipóteses é a verdadeira.
 */
describe("liberação manual sobre cobrança automática viva", () => {
  async function comCartaoAtivo(externalRef: string, nextRenewalAt: Date | null) {
    const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org`, ownerId: clienteId } });
    await prisma.user.update({ where: { id: clienteId }, data: { organizationId: org.id, orgRole: "OWNER" } });
    return prisma.subscription.create({
      data: {
        organizationId: org.id,
        planId: planoId,
        status: "ATIVA",
        provider: "ASAAS",
        externalRef,
        amountCents: 4990,
        nextRenewalAt,
        currentPeriodEnd: new Date(Date.now() + 12 * 86_400_000),
        maxUsers: 1,
        analysesQuota: 20,
      },
    });
  }

  it("LIBERA — não bloqueia, porque bloquear quebra a rede de segurança do webhook", async () => {
    const cartao = await comCartaoAtivo("sub_test_manual_cartao", new Date(Date.now() + 12 * 86_400_000));

    const r = await ativar();

    // O acesso saiu: é este o ponto da decisão.
    expect(r.subscriptionId).toBe(cartao.id);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: cartao.id } });
    expect(sub.status).toBe("ATIVA");
    expect(r.creditosLiberados).toBeGreaterThan(0);
  });

  it("avisa quem liberou, com a recorrência e a data da próxima cobrança", async () => {
    await comCartaoAtivo("sub_test_manual_cartao", new Date(Date.now() + 12 * 86_400_000));

    const r = await ativar();

    // O aviso volta na resposta porque quem está na tela é quem sabe qual hipótese é a certa.
    expect(r.avisoCobrancaAutomatica).toBeDefined();
    expect(r.avisoCobrancaAutomatica).toContain("sub_test_manual_cartao");
    expect(r.avisoCobrancaAutomatica).toContain("Interromper cobrança");

    // E fica registrado, para não se perder quando vier por script ou pela tela ignorada.
    const evento = await prisma.securityEvent.findFirstOrThrow({
      where: { type: ALERTA_COBRANCA_DUPLA, metadata: { path: ["subscriptionId"], equals: r.subscriptionId } },
    });
    expect((evento.metadata as Record<string, unknown>).recorrencia).toBe("sub_test_manual_cartao");
  });

  it("venda por fora sem cobrança anterior NÃO gera aviso", async () => {
    const r = await ativar();

    // Aviso onde não há nada a decidir treina o dono a ignorar o alerta que importa.
    expect(r.avisoCobrancaAutomatica).toBeUndefined();
    expect(await prisma.securityEvent.count({ where: { type: ALERTA_COBRANCA_DUPLA } })).toBe(0);
  });

  it("id de PAGAMENTO não é confundido com recorrência — PIX não gera aviso", async () => {
    /**
     * `externalRef` de PIX guarda o id do PAGAMENTO (`pay_...`), não de uma assinatura, e
     * cobrança única não se repete. Confundir os dois já produziu alerta falso de
     * "recorrência duplicada" no caminho normal de quem pagou por PIX.
     *
     * A data de renovação vai preenchida DE PROPÓSITO, estado que o PIX nunca tem, para o
     * teste isolar a outra metade da pergunta: aqui só o formato da referência decide.
     */
    await comCartaoAtivo("pay_test_manual_pix", new Date(Date.now() + 12 * 86_400_000));

    const r = await ativar();

    expect(r.avisoCobrancaAutomatica).toBeUndefined();
    expect(await prisma.securityEvent.count({ where: { type: ALERTA_COBRANCA_DUPLA } })).toBe(0);
  });

  it("cobrança já interrompida não gera aviso", async () => {
    // `nextRenewalAt` nulo é o registro de "não há cobrança seguinte" — nada a decidir.
    await comCartaoAtivo("sub_test_manual_parada", null);

    const r = await ativar();

    expect(r.avisoCobrancaAutomatica).toBeUndefined();
  });
});

