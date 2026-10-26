import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * A ROTA de emissão de boleto — e por que ela precisava de teste próprio.
 *
 * ── O defeito que passou por vinte testes ─────────────────────────────────────
 * tests/asaas-boleto.test.ts cobre bem o boleto: contratação, renovação, janela de
 * compensação, encerramento. Só que todos aqueles testes chamam a BIBLIOTECA
 * (`criarAssinaturaBoleto`) direto, e o defeito estava na ROTA, uma camada acima:
 *
 *   if (!ctx.organization) return fail("Organização não encontrada.", 400);
 *
 * A rota nunca usou a organização — trabalha com `ctx.user` e `ctx.currentSubscription`.
 * Era um portão sem porta atrás, e ele recusava a emissão para toda conta sem
 * organização: o ADMIN da semente, um REVISOR, um SUPORTE. Foi o primeiro erro que
 * apareceu no primeiro teste de boleto pela tela do site.
 *
 * Cartão e PIX nunca precisaram: a rota de checkout também só usa `ctx.user`, e é o
 * webhook que cria a organização quando o dinheiro entra. A assimetria era o defeito.
 *
 * A lição que este arquivo registra: teste de biblioteca não cobre guarda de rota. Onde a
 * decisão mora, o teste tem de bater.
 */

process.env.ASAAS_API_KEY = "chave-de-teste-nao-vai-para-a-rede";
process.env.ASAAS_ENV = "sandbox";
// 32 bytes exatos, que é o que `src/lib/crypto.ts` exige. O valor anterior
// ("0" 64 vezes) decodificava para 48 bytes e derrubava a criptografia do CPF:
// a rota respondia 502 e o teste só passava em máquina que já exportasse a
// chave no ambiente — ou seja, falhava em toda cópia recém-clonada.
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");

const contexto = vi.hoisted(() => ({
  userId: "",
  /** Nulo de propósito no caso principal: é o estado que a rota recusava. */
  orgId: null as string | null,
  subId: null as string | null,
  papel: "CLIENTE" as string,
}));

vi.mock("@/lib/tenant", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/tenant")>();
  const { PrismaClient: PC } = await import("@prisma/client");
  const db = new PC();
  return {
    ...real,
    requireAppContext: async () => {
      const user = await db.user.findUniqueOrThrow({ where: { id: contexto.userId } });
      const org = contexto.orgId ? await db.organization.findUnique({ where: { id: contexto.orgId } }) : null;
      const sub = contexto.subId ? await db.subscription.findUnique({ where: { id: contexto.subId } }) : null;
      return {
        user: { id: user.id, email: user.email, name: user.name, role: contexto.papel },
        organization: org,
        subscription: sub,
        currentSubscription: sub,
        access: { hasAccess: Boolean(sub), reason: "ativa", message: "" },
        quota: { unlimited: false, quota: 20, used: 0, extra: 0, remaining: 20, allowed: true },
      };
    },
  };
});

const { POST: EMITIR_BOLETO } = await import("../src/app/api/assinatura/boleto/route");
const { ativarAssinaturaManual } = await import("../src/lib/ativacao-manual");

const prisma = new PrismaClient();
/**
 * ⚠️ O prefixo NÃO pode começar com o prefixo de outro arquivo.
 *
 * Este era "test-boleto-rota", e `test-boleto` (de tests/asaas-boleto.test.ts) é prefixo
 * dele. As limpezas usam `startsWith`, então aquele arquivo apagava o plano DESTE no meio
 * da execução — e o resultado foi o pior tipo de teste: passava isolado, passava na segunda
 * rodada, e falhava na primeira depois de zerar o banco, com "Plano não encontrado". Erro
 * que parece defeito de código e não é.
 */
const PREFIXO = "test-rota-bol";
const SUB_ASAAS = "sub_rota_boleto";

let planoId = "";

/** API do Asaas simulada: cliente + assinatura + listagem da cobrança. */
function simularAsaas() {
  const chamadas: { metodo: string; url: string; corpo: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const alvo = String(url);
    chamadas.push({
      metodo: String(init?.method ?? "GET"),
      url: alvo,
      corpo: init?.body ? JSON.parse(String(init.body)) : {},
    });
    const responder = (corpo: unknown) =>
      new Response(JSON.stringify(corpo), { status: 200, headers: { "Content-Type": "application/json" } });

    if (alvo.includes("/customers")) return responder({ id: "cus_rota_teste" });
    if (alvo.includes("/payments")) {
      return responder({
        data: [{ bankSlipUrl: "https://asaas.test/boleto", invoiceUrl: "https://asaas.test/fatura", dueDate: "2026-08-05" }],
      });
    }
    if (alvo.includes("/subscriptions")) return responder({ id: SUB_ASAAS });
    return responder({});
  });
  return chamadas;
}

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orgs = await prisma.organization.findMany({
    where: { OR: [{ name: { startsWith: PREFIXO } }, { ownerId: { in: ids } }] },
    select: { id: true },
  });
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

beforeAll(async () => {
  await limpar();
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-mensal`,
      name: "Mensal (rota boleto)",
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

beforeEach(async () => {
  vi.unstubAllGlobals();
  await limpar();
  const plano = await prisma.plan.findUniqueOrThrow({ where: { id: planoId } }).catch(async () =>
    prisma.plan.create({
      data: {
        slug: `${PREFIXO}-mensal`,
        name: "Mensal (rota boleto)",
        priceCents: 4990,
        period: "MENSAL",
        monthlyAnalyses: 20,
        maxUsers: 1,
      },
    }),
  );
  planoId = plano.id;

  const user = await prisma.user.create({
    data: {
      email: `${PREFIXO}-sem-org@exemplo.local`,
      name: "Sem Organização",
      passwordHash: "x",
      role: "CLIENTE",
      /**
       * E-mail confirmado, porque contratar passou a exigir isso. Estes testes falam de OUTRA
       * coisa — a guarda de organização, o documento criptografado, a cobrança dupla — e sem a
       * data eles passariam a medir o gate de e-mail em vez do que se propõem a medir. A recusa
       * por e-mail não confirmado tem teste próprio, abaixo.
       */
      emailVerifiedAt: new Date(),
    },
  });
  contexto.userId = user.id;
  contexto.orgId = null;
  contexto.subId = null;
  contexto.papel = "CLIENTE";
});

/** CPF válido nos dígitos verificadores (gerado para teste). */
const CPF_VALIDO = "52998224725";

function pedido(corpo: Record<string, unknown>) {
  return new Request("http://localhost/api/assinatura/boleto", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  }) as never;
}

describe("conta SEM organização", () => {
  /**
   * O caso que falhou na primeira tentativa pela tela. A organização nasce no cadastro
   * pelo site e, na primeira aprovação de pagamento, dentro do webhook. Conta criada por
   * outro caminho não tem — e não precisa ter para emitir um boleto.
   */
  it("emite o boleto — a organização não é necessária aqui", async () => {
    const chamadas = simularAsaas();

    const res = await EMITIR_BOLETO(pedido({ planoSlug: `${PREFIXO}-mensal`, cpfCnpj: CPF_VALIDO }));
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.assinaturaId).toBe(SUB_ASAAS);
    expect(corpo.data.boletoUrl).toContain("asaas.test");
    // A recorrência foi criada de verdade no provedor.
    expect(chamadas.some((c) => c.metodo === "POST" && c.url.includes("/subscriptions"))).toBe(true);
  });

  it("vale para o ADMIN, que é quem a semente cria sem organização", async () => {
    contexto.papel = "ADMIN";
    simularAsaas();

    const res = await EMITIR_BOLETO(pedido({ planoSlug: `${PREFIXO}-mensal`, cpfCnpj: CPF_VALIDO }));

    expect(res.status).toBe(200);
  });

  it("o externalReference amarra a cobrança à CONTA, que é o vínculo que o webhook lê", async () => {
    const chamadas = simularAsaas();

    await EMITIR_BOLETO(pedido({ planoSlug: `${PREFIXO}-mensal`, cpfCnpj: CPF_VALIDO }));

    const assinatura = chamadas.find((c) => c.metodo === "POST" && c.url.includes("/subscriptions"));
    expect(assinatura?.corpo.externalReference).toBe(`plano:${PREFIXO}-mensal:user:${contexto.userId}`);
  });
});

describe("guardas que continuam valendo", () => {
  it("recusa quem já tem assinatura que renova sozinha — seriam duas cobranças", async () => {
    const org = await prisma.organization.create({
      data: { name: `${PREFIXO}-org`, ownerId: contexto.userId },
    });
    const sub = await prisma.subscription.create({
      data: {
        organizationId: org.id,
        planId: planoId,
        status: "ATIVA",
        provider: "ASAAS",
        amountCents: 4990,
        // O sinal de "esta assinatura se cobra sozinha".
        nextRenewalAt: new Date(Date.now() + 20 * 86400000),
        currentPeriodEnd: new Date(Date.now() + 20 * 86400000),
        maxUsers: 1,
        analysesQuota: 20,
      },
    });
    contexto.orgId = org.id;
    contexto.subId = sub.id;
    const chamadas = simularAsaas();

    const res = await EMITIR_BOLETO(pedido({ planoSlug: `${PREFIXO}-mensal`, cpfCnpj: CPF_VALIDO }));

    expect(res.status).toBe(409);
    // E nada foi criado no provedor: duas recorrências é cobrança dupla todo mês.
    expect(chamadas).toHaveLength(0);
  });

  /**
   * ⚠️ O guarda tem de PARAR de recusar quem a própria rota declara seguro.
   *
   * O docblock da regra nomeia os dois casos em que emitir boleto é seguro — PIX e
   * liberação manual —, porque nenhum dos dois tem recorrência a duplicar. Só que a
   * ativação manual gravava `nextRenewalAt`, e é ele que o guarda lê. Duas partes escritas
   * para concordar discordavam pelo dado: o cliente de venda por transferência que quisesse
   * passar a pagar por boleto era recusado com "sua assinatura já renova automaticamente" —
   * afirmação falsa — e mandado cancelar primeiro. Venda perdida dentro do produto.
   */
  it("cliente de venda MANUAL pode contratar por boleto", async () => {
    const admin = await prisma.user.create({
      data: { email: `${PREFIXO}-dono@exemplo.local`, name: "Dono", passwordHash: "x", role: "ADMIN" },
    });
    const r = await ativarAssinaturaManual(
      {
        email: `${PREFIXO}-sem-org@exemplo.local`,
        planoSlug: `${PREFIXO}-mensal`,
        metodo: "transferencia",
        motivo: "Venda por transferência bancária",
        enviarConvite: false,
      },
      { id: admin.id },
    );
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: r.subscriptionId } });
    expect(sub.status).toBe("ATIVA");
    contexto.orgId = sub.organizationId;
    contexto.subId = sub.id;

    const chamadas = simularAsaas();
    const res = await EMITIR_BOLETO(pedido({ planoSlug: `${PREFIXO}-mensal`, cpfCnpj: CPF_VALIDO }));

    expect(res.status).toBe(200);
    // E a recorrência foi criada de verdade: a venda acontece.
    expect(chamadas.some((c) => c.metodo === "POST" && c.url.includes("/subscriptions"))).toBe(true);
  });

  /**
   * ⚠️ Contratar exige e-mail confirmado — decisão do dono.
   *
   * E-mail errado no cadastro só cobra o preço quando alguém paga: depois disso, o aviso de
   * acesso, a recuperação de senha, a segunda via do boleto e o aviso de cobrança passam todos
   * por aquele endereço. No boleto pesa mais, porque a cobrança é ENVIADA por e-mail — endereço
   * inalcançável significa boleto emitido que o cliente nunca vê.
   */
  it("recusa contratar com e-mail NÃO confirmado, e diz o que fazer", async () => {
    await prisma.user.update({ where: { id: contexto.userId }, data: { emailVerifiedAt: null } });
    const chamadas = simularAsaas();

    const res = await EMITIR_BOLETO(pedido({ planoSlug: `${PREFIXO}-mensal`, cpfCnpj: CPF_VALIDO }));
    const corpo = await res.json();

    expect(res.status).toBe(403);
    expect(corpo.reason).toBe("email_nao_confirmado");
    // A recusa tem de resolver, não só anunciar: reenvio e o caminho do endereço errado.
    expect(corpo.error).toContain("Reenviar");
    // E o caminho para endereço errado, que agora é auto-serviço em vez de suporte.
    expect(corpo.error).toContain("Trocar o e-mail");
    // E nada foi criado no provedor: cobrança emitida que ninguém vê é pior que venda recusada.
    expect(chamadas).toHaveLength(0);
  });

  it("⚠️ a recusa mais ESPECÍFICA vem primeiro: cobrança dupla antes do e-mail", async () => {
    /**
     * As duas recusas seriam verdadeiras para quem tem recorrência ativa E e-mail não confirmado.
     * Só uma descreve a situação da pessoa e diz o que fazer. Com o gate de e-mail antes, quem já
     * tinha assinatura recebia "confirme seu e-mail" — verdadeiro e inútil.
     */
    await prisma.user.update({ where: { id: contexto.userId }, data: { emailVerifiedAt: null } });
    const org = await prisma.organization.create({ data: { name: `${PREFIXO}-org`, ownerId: contexto.userId } });
    const sub = await prisma.subscription.create({
      data: {
        organizationId: org.id,
        planId: planoId,
        status: "ATIVA",
        provider: "ASAAS",
        amountCents: 4990,
        nextRenewalAt: new Date(Date.now() + 20 * 86400000),
        currentPeriodEnd: new Date(Date.now() + 20 * 86400000),
        maxUsers: 1,
        analysesQuota: 20,
      },
    });
    contexto.orgId = org.id;
    contexto.subId = sub.id;
    simularAsaas();

    const res = await EMITIR_BOLETO(pedido({ planoSlug: `${PREFIXO}-mensal`, cpfCnpj: CPF_VALIDO }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("renova automaticamente");
  });

  it("documento inválido é recusado ANTES de falar com o provedor", async () => {
    const chamadas = simularAsaas();

    const res = await EMITIR_BOLETO(pedido({ planoSlug: `${PREFIXO}-mensal`, cpfCnpj: "11111111111" }));

    expect(res.status).toBe(422);
    // Erro no campo, e não erro cru de gateway no meio da compra.
    expect(chamadas).toHaveLength(0);
  });
});

describe("o documento é dado pessoal", () => {
  it("fica guardado CRIPTOGRAFADO, nunca em claro", async () => {
    simularAsaas();

    await EMITIR_BOLETO(pedido({ planoSlug: `${PREFIXO}-mensal`, cpfCnpj: CPF_VALIDO }));

    const user = await prisma.user.findUniqueOrThrow({ where: { id: contexto.userId } });
    expect(user.documentEnc).not.toBeNull();
    // O CPF em claro não pode aparecer no banco (LGPD): o valor em claro só transita
    // para o provedor.
    expect(user.documentEnc).not.toContain(CPF_VALIDO);
    expect(user.documentType).toBe("CPF");
  });

  it("não vai para a auditoria", async () => {
    simularAsaas();

    await EMITIR_BOLETO(pedido({ planoSlug: `${PREFIXO}-mensal`, cpfCnpj: CPF_VALIDO }));

    const registro = await prisma.auditLog.findFirstOrThrow({
      where: { action: "subscription.boleto_emitido", entityId: contexto.userId },
    });
    expect(JSON.stringify(registro.metadata)).not.toContain(CPF_VALIDO);
  });
});
