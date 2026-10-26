import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * O prazo do pedido de exclusão do titular — art. 19, II, da LGPD.
 *
 * ── O defeito ─────────────────────────────────────────────────────────────────
 * A rota do cliente registra o pedido e avisa: notificação para o titular, notificação para
 * cada administrador e e-mail para o canal de privacidade. Isso resolveu o pedido que se
 * perdia — e depois disso NADA acompanhava o prazo.
 *
 * O que os documentos publicam não é pouco. A Política de Cancelamento e Retenção diz que a
 * resposta completa sai em até 15 dias "na forma do art. 19, II, da LGPD" e que "no mesmo
 * prazo é executada a exclusão ou a anonimização dos dados que não estejam entre os de
 * conservação obrigatória". Não é só responder: é executar.
 *
 * Sem vigilância o desfecho é o do prazo de revisão de estorno antes de ganhar varredura: a
 * notificação fica numa lista, ninguém volta nela, e o prazo vence em silêncio. Aqui isso dá
 * ao titular razão numa reclamação à ANPD (art. 18, §3º).
 */

const { vigiarPrazosDoTitular, contarPedidosEmAberto, PRAZO_RESPOSTA_TITULAR_DIAS, DIAS_DE_ANTECEDENCIA_DO_AVISO } =
  await import("../src/lib/pedido-do-titular");

const prisma = new PrismaClient();
const PREFIXO = "test-titular";

const ALERTAS = ["lgpd_prazo_do_titular_proximo", "lgpd_prazo_do_titular_vencido"];

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  /**
   * A auditoria do pedido sobrevive à exclusão da conta — é o ponto dela. Então a limpeza
   * por id de conta não alcança as linhas de conta já apagada, e sem isto um pedido de
   * rodada anterior seria contado como aberto na próxima.
   */
  await prisma.auditLog.deleteMany({
    where: { action: { in: ["account.deletion_requested", "conta.apagada", "lgpd.prazo_do_titular_avisado"] }, entityId: { startsWith: PREFIXO } },
  });
  await prisma.securityEvent.deleteMany({ where: { type: { in: ALERTAS } } });
}

beforeEach(limpar);

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

/**
 * Conta com pedido de exclusão feito há `diasAtras`.
 *
 * O `entityId` da auditoria é o id da conta, e é assim que a rota real grava — o prefixo no
 * id é impossível, então a conta usa e-mail prefixado e a limpeza vai pelos dois caminhos.
 */
async function contaComPedido(sufixo: string, diasAtras: number) {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Titular ${sufixo}`,
      passwordHash: "x",
      role: "CLIENTE",
      status: "ATIVO",
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: user.id,
      action: "account.deletion_requested",
      entityType: "User",
      entityId: user.id,
      createdAt: new Date(Date.now() - diasAtras * 86_400_000),
      metadata: { avisoEnviado: true, administradoresNotificados: 1 },
    },
  });
  return user;
}

describe("prazo ainda com folga", () => {
  it("pedido recente não gera aviso — avisar cedo demais treina a ignorar", async () => {
    await contaComPedido("recente", 1);

    const r = await vigiarPrazosDoTitular();

    expect(r.abertos).toBe(1);
    expect(r.avisadosProximos).toBe(0);
    expect(r.avisadosVencidos).toBe(0);
    expect(await prisma.securityEvent.count({ where: { type: { in: ALERTAS } } })).toBe(0);
  });
});

describe("prazo se aproximando", () => {
  it("avisa ANTES de vencer, com os dias restantes", async () => {
    /**
     * Um dia dentro da janela de antecedência. Avisar só no vencimento seria avisar do
     * descumprimento em vez de evitá-lo.
     */
    const diasAtras = PRAZO_RESPOSTA_TITULAR_DIAS - DIAS_DE_ANTECEDENCIA_DO_AVISO + 1;
    const user = await contaComPedido("proximo", diasAtras);

    const r = await vigiarPrazosDoTitular();

    expect(r.avisadosProximos).toBe(1);
    expect(r.avisadosVencidos).toBe(0);

    const evento = await prisma.securityEvent.findFirstOrThrow({
      where: { type: "lgpd_prazo_do_titular_proximo", metadata: { path: ["userId"], equals: user.id } },
    });
    const meta = evento.metadata as Record<string, unknown>;
    expect(meta.etapa).toBe("proximo");
    expect(Number(meta.diasRestantes)).toBeLessThanOrEqual(DIAS_DE_ANTECEDENCIA_DO_AVISO);
    expect(Number(meta.diasRestantes)).toBeGreaterThan(0);
  });

  it("não repete o aviso da mesma etapa em rodadas seguintes", async () => {
    const diasAtras = PRAZO_RESPOSTA_TITULAR_DIAS - DIAS_DE_ANTECEDENCIA_DO_AVISO + 1;
    await contaComPedido("repete", diasAtras);

    await vigiarPrazosDoTitular();
    const segunda = await vigiarPrazosDoTitular();

    /**
     * A varredura roda todo dia. Sem esta trava, o mesmo pedido geraria alerta diário até
     * alguém agir — e alerta repetido é alerta ignorado, no pior lugar possível para isso.
     */
    expect(segunda.avisadosProximos).toBe(0);
    expect(await prisma.securityEvent.count({ where: { type: "lgpd_prazo_do_titular_proximo" } })).toBe(1);
  });
});

describe("prazo vencido", () => {
  it("avisa com o texto de PRAZO VENCIDO, e é um alerta distinto do de antecedência", async () => {
    const user = await contaComPedido("vencido", PRAZO_RESPOSTA_TITULAR_DIAS + 3);

    const r = await vigiarPrazosDoTitular();

    expect(r.avisadosVencidos).toBe(1);
    expect(r.avisadosProximos).toBe(0);

    const evento = await prisma.securityEvent.findFirstOrThrow({
      where: { type: "lgpd_prazo_do_titular_vencido", metadata: { path: ["userId"], equals: user.id } },
    });
    expect(String((evento.metadata as Record<string, unknown>).assunto)).toContain("PRAZO VENCIDO");
    /**
     * Etapas separadas de propósito: um pedido que passou pela antecedência e venceu recebe
     * DOIS avisos, não um. O segundo é o que diz que a promessa publicada foi descumprida.
     */
    expect((evento.metadata as Record<string, unknown>).etapa).toBe("vencido");
  });
});

describe("pedido já atendido", () => {
  it("conta apagada encerra o pedido — nada é cobrado depois de feito", async () => {
    const user = await contaComPedido("feito", PRAZO_RESPOSTA_TITULAR_DIAS + 3);
    /**
     * O registro que `apagarConta` grava. Vem antes de apagar a conta de propósito neste
     * teste: prova que é a EXECUÇÃO que encerra o pedido, e não só a conta ter desaparecido.
     */
    await prisma.auditLog.create({
      data: { action: "conta.apagada", entityType: "User", entityId: user.id, metadata: { email: user.email } },
    });

    const r = await vigiarPrazosDoTitular();

    expect(r.abertos).toBe(0);
    expect(r.avisadosVencidos).toBe(0);
    expect(await prisma.securityEvent.count({ where: { type: { in: ALERTAS } } })).toBe(0);
  });

  it("conta que deixou de existir também encerra o pedido", async () => {
    const user = await contaComPedido("sumiu", PRAZO_RESPOSTA_TITULAR_DIAS + 3);
    // A auditoria do pedido sobrevive à conta: é justamente o caso que precisa de guarda.
    await prisma.user.delete({ where: { id: user.id } });

    const r = await vigiarPrazosDoTitular();

    expect(r.abertos).toBe(0);
    expect(await prisma.securityEvent.count({ where: { type: { in: ALERTAS } } })).toBe(0);
  });
});

describe("o número do painel e o da varredura", () => {
  it("o contador da tela usa a MESMA regra do alerta", async () => {
    await contaComPedido("painel-1", 1);
    await contaComPedido("painel-2", PRAZO_RESPOSTA_TITULAR_DIAS + 3);
    const atendido = await contaComPedido("painel-3", PRAZO_RESPOSTA_TITULAR_DIAS + 3);
    await prisma.auditLog.create({
      data: { action: "conta.apagada", entityType: "User", entityId: atendido.id, metadata: {} },
    });

    const r = await vigiarPrazosDoTitular();

    /**
     * Tela e alerta discordando sobre o que é pendência destrói a confiança nos dois
     * números — por isso os dois saem da mesma função.
     */
    expect(await contarPedidosEmAberto()).toBe(r.abertos);
    expect(r.abertos).toBe(2);
  });
});
