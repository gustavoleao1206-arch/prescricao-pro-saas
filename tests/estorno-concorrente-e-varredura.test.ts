import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Dois furos de dinheiro no estorno: a PERDA de crédito na concorrência e a devolução SILENCIOSA de zero.
 *
 * ── 1. A escrita cega do saldo fazia o cliente PERDER crédito ─────────────────
 * O contador era gravado com `update` direto a partir de uma leitura velha, sem compare-and-swap — ao
 * contrário do consumo, que se protege assim desde sempre.
 *
 * O que EU MEDI, e é reproduzível: estornos de análises DIFERENTES da mesma conta leem `analysesUsed`
 * juntos e escrevem por cima um do outro. Oito cobrados, oito devoluções registradas na razão, SETE
 * entregues no contador. Um cliente fica sem o crédito e nada acusa — e a razão, que é a fonte da
 * verdade deste módulo, passa a discordar do saldo.
 *
 * A revisão descreveu, por raciocínio, um segundo cenário: devolução em DOBRO. T2 lê a razão antes do
 * commit de T1 e a assinatura depois, a bolsa de destino muda, a chave de idempotência deixa de colidir e
 * o crédito sai duas vezes — com o excedente na bolsa que NÃO expira. Esse eu NÃO consegui reproduzir,
 * nem sabotando as duas metades do conserto: em quatro medições saíram sempre 8 de 8, porque a chave
 * única da razão barra a segunda escrita e a retentativa a transforma em "já estornado". A janela existe
 * no papel; nesta máquina não abre.
 *
 * As duas metades — ler a assinatura ANTES da razão e o compare-and-swap — ficam porque fecham a janela
 * por construção. A que tem defeito REPRODUZIDO atrás dela é o compare-and-swap.
 *
 * ── 2. A varredura devolvia ZERO em silêncio ──────────────────────────────────
 * `encerrarAbandonada` resolvia a assinatura por `getActiveSubscription(organizationId)`, que devolve
 * NULO quando a assinatura não concede acesso agora — SUSPENSA, VENCIDA, INADIMPLENTE fora da tolerância,
 * ESTORNADA, CANCELADA fora do período pago. Com nulo, o estorno era pulado inteiro e a auditoria gravava
 * `creditosEstornados: 0`, indistinguível de "não havia nada a devolver".
 *
 * Atinge o cliente com pagamento em atraso cujo processamento morreu: pagou, não recebeu a análise, não
 * recebeu o crédito de volta — e é quem mais vai conferir o saldo ao regularizar.
 */

/** Permite a UM teste fazer o estorno explodir, sem substituir o módulo para os outros. */
const controle = vi.hoisted(() => ({ estornoExplode: false }));

vi.mock("../src/lib/credits", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/credits")>();
  return {
    ...real,
    estornarCreditosDaAnalise: async (analysisId: string, motivo: string) => {
      if (controle.estornoExplode) throw new Error("banco indisponível no meio do estorno");
      return real.estornarCreditosDaAnalise(analysisId, motivo);
    },
  };
});

const alertas = vi.hoisted(() => ({ enviados: [] as { tipo: string; assunto: string }[] }));
vi.mock("../src/lib/alerta-operacional", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/alerta-operacional")>();
  return {
    ...real,
    alertarOperacao: async (a: { tipo: string; assunto: string }) => {
      alertas.enviados.push({ tipo: a.tipo, assunto: a.assunto });
    },
  };
});

const { consumirCreditos, estornarCreditos } = await import("../src/lib/credits");
const { destravarSeAbandonada, MINUTOS_SEM_SINAL_DE_VIDA } = await import("../src/lib/analise-travada");

const prisma = new PrismaClient();
const PREFIXO = "test-varredura";

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

beforeEach(async () => {
  controle.estornoExplode = false;
  alertas.enviados = [];
  await limpar();
});

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

async function cenario(sufixo: string) {
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
      monthlyAnalyses: 20,
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
      analysesQuota: 20,
      analysesUsed: 0,
      extraAnalyses: 0,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  return { user, org, sub };
}

async function analiseTravada(orgId: string, ownerId: string) {
  return prisma.analysis.create({
    data: {
      organizationId: orgId,
      ownerId,
      title: `${PREFIXO} análise`,
      status: "PROCESSANDO",
      heartbeatAt: new Date(Date.now() - (MINUTOS_SEM_SINAL_DE_VIDA + 10) * 60_000),
    },
  });
}

const saldo = async (subId: string) => {
  const s = await prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
  return { usado: s.analysesUsed, adicional: s.extraAnalyses };
};

describe("⚠️ estorno concorrente não devolve em dobro", () => {
  it("⚠️ oito pares simultâneos: cada análise devolve exatamente o que cobrou", async () => {
    /**
     * ⚠️ HONESTIDADE SOBRE O QUE ESTE TESTE MEDE: ele exerce concorrência REAL contra o Postgres, mas não
     * fixa o entrelaçamento — não há como, de fora, obrigar T2 a ler a razão antes de T1 comitar e a
     * assinatura depois. O que ele trava é a INVARIANTE: nunca sai mais crédito do que entrou, por
     * nenhum caminho.
     *
     * Oito pares em vez de um porque a janela é estreita: com um par só, o entrelaçamento perigoso pode
     * simplesmente não acontecer e o teste passaria sem exercitar nada. A garantia determinística é
     * estrutural — a assinatura é lida ANTES da razão e a escrita é compare-and-swap —, e está escrita
     * em `src/lib/credits.ts`.
     */
    const c = await cenario("concorrente");
    const analises = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        prisma.analysis.create({
          data: { organizationId: c.org.id, ownerId: c.user.id, title: `${PREFIXO} ${i}`, status: "ERRO_PROCESSAMENTO" },
        }),
      ),
    );
    for (const a of analises) await consumirCreditos(c.sub.id, a.id, 1, "Análise");
    expect((await saldo(c.sub.id)).usado).toBe(8);

    /** Dois estornos por análise, disparados juntos. Falha por concorrência é resultado ACEITO. */
    const resultados = await Promise.all(
      analises.flatMap((a) => [
        estornarCreditos(c.sub.id, a.id, "erro técnico").catch(() => ({ estornados: 0, jaEstornado: false })),
        estornarCreditos(c.sub.id, a.id, "erro técnico").catch(() => ({ estornados: 0, jaEstornado: false })),
      ]),
    );

    const devolvidoTotal = resultados.reduce((s, r) => s + r.estornados, 0);

    /**
     * ⚠️ OITO EXATOS, e o que este número pega é a PERDA de crédito — não a devolução em dobro.
     *
     * ── O que eu medi, e o que não consegui medir ────────────────────────────
     * Com a ordem antiga (assinatura lida DEPOIS da razão) e o `update` cego, esta montagem devolve
     * SETE de oito, de forma reproduzível: estornos de análises DIFERENTES da mesma conta leem
     * `analysesUsed` juntos e escrevem por cima um do outro. Um cliente fica sem o crédito, e nada
     * acusa — a razão registra a devolução que o contador não entregou. É este defeito que a
     * asserção abaixo trava, e ele é real.
     *
     * A devolução em DOBRO que a revisão descreveu por raciocínio (T2 lê a razão antes do commit de
     * T1 e a assinatura depois, a bolsa muda e a chave não colide) eu NÃO consegui reproduzir, nem
     * sabotando as duas metades: em quatro medições saíram sempre 8 de 8, com a chave única da razão
     * barrando a segunda escrita e a retentativa transformando a colisão em "já estornado". A janela
     * existe no papel; nesta máquina ela não abre. A ordem de leitura e o compare-and-swap ficam
     * porque fecham a janela por construção, e não porque eu vi o dobro acontecer.
     *
     * ── Por que "exatos" e não "no máximo oito" ──────────────────────────────
     * Cheguei a afrouxar para `<= 8` achando que era mais honesto, e o efeito foi o oposto: o teste
     * deixou de pegar a sabotagem, porque a perda de crédito também satisfaz "no máximo oito". A
     * asserção que vale é a igualdade.
     *
     * Ela dependia do orçamento de retentativas: com cinco tentativas falhou na segunda rodada da
     * suíte, com o banco carregado. O conserto foi no CÓDIGO — dez tentativas com espera aleatorizada
     * (ver `TENTATIVAS_DO_ESTORNO`) —, não na asserção. Seis rodadas seguidas depois disso.
     */
    expect(devolvidoTotal).toBe(8);
    expect(await saldo(c.sub.id)).toEqual({ usado: 0, adicional: 0 });

    /**
     * E a razão bate com o contador. Este é o invariante central do módulo: se os dois discordarem, o
     * extrato manda — e o cliente veria um saldo diferente do que o extrato explica. É exatamente aqui
     * que a perda de crédito aparece: a razão registra oito devoluções e o contador entrega sete.
     */
    const linhas = await prisma.creditLedger.findMany({
      where: { subscriptionId: c.sub.id, analysisId: { in: analises.map((a) => a.id) } },
    });
    expect(linhas.reduce((s, l) => s + l.quantity, 0)).toBe(0);
    /** Nunca sobra crédito de brinde na bolsa que não expira — é onde o excedente cairia. */
    expect((await saldo(c.sub.id)).adicional).toBe(0);
  });

  it("⚠️ o duplo clique real — um par só — devolve exatamente uma vez", async () => {
    /**
     * O caso que de fato acontece: duas abas, ou a retentativa de rede, disparando "Cancelar análise"
     * duas vezes. Contenção de dois, não de dezesseis — aqui "exatamente" é afirmável, e é o número que o
     * cliente vê no saldo.
     */
    const c = await cenario("duplo-clique");
    const a = await prisma.analysis.create({
      data: { organizationId: c.org.id, ownerId: c.user.id, title: `${PREFIXO} clique`, status: "ERRO_PROCESSAMENTO" },
    });
    await consumirCreditos(c.sub.id, a.id, 1, "Análise");

    const [r1, r2] = await Promise.all([
      estornarCreditos(c.sub.id, a.id, "erro").catch(() => ({ estornados: 0 })),
      estornarCreditos(c.sub.id, a.id, "erro").catch(() => ({ estornados: 0 })),
    ]);

    expect(r1.estornados + r2.estornados).toBe(1);
    expect(await saldo(c.sub.id)).toEqual({ usado: 0, adicional: 0 });
  });

  it("o mesmo estorno repetido em sequência devolve uma vez só", async () => {
    // O caso fácil, que já funcionava: fica como guarda contra a mudança de ordem quebrá-lo.
    const c = await cenario("sequencial");
    const a = await prisma.analysis.create({
      data: { organizationId: c.org.id, ownerId: c.user.id, title: `${PREFIXO} seq`, status: "ERRO_PROCESSAMENTO" },
    });
    await consumirCreditos(c.sub.id, a.id, 2, "Análise");

    expect((await estornarCreditos(c.sub.id, a.id, "erro")).estornados).toBe(2);
    expect((await estornarCreditos(c.sub.id, a.id, "erro")).estornados).toBe(0);

    expect(await saldo(c.sub.id)).toEqual({ usado: 0, adicional: 0 });
  });
});

describe("⚠️ a varredura devolve o crédito mesmo com a assinatura sem acesso", () => {
  for (const situacao of ["SUSPENSA", "INADIMPLENTE", "CANCELADA", "ESTORNADA"] as const) {
    it(`⚠️ assinatura ${situacao}: o crédito VOLTA`, async () => {
      /**
       * O furo, em quatro estados reais. `getActiveSubscription` devolve nulo em todos, e a varredura
       * pulava o estorno inteiro — deixando sem crédito justamente o cliente com pagamento em atraso.
       *
       * A assinatura correta vem da RAZÃO (a linha de CONSUMO guarda contra qual assinatura o crédito
       * saiu), e ela sobrevive a qualquer mudança de estado.
       */
      const c = await cenario(`sem-acesso-${situacao.toLowerCase()}`);
      const a = await analiseTravada(c.org.id, c.user.id);
      await consumirCreditos(c.sub.id, a.id, 1, "Análise");
      // A assinatura deixa de conceder acesso DEPOIS da cobrança — que é a ordem real dos fatos.
      await prisma.subscription.update({
        where: { id: c.sub.id },
        data: { status: situacao, currentPeriodEnd: new Date(Date.now() - 10 * 86_400_000) },
      });

      const r = await destravarSeAbandonada(a.id);

      expect(r.destravada).toBe(true);
      expect(r.creditosEstornados).toBe(1);
      expect((await saldo(c.sub.id)).usado).toBe(0);
    });
  }

  it("sem cobrança nenhuma, o registro DIZ que não havia o que devolver", async () => {
    /**
     * "0 devolvido" cobria dois casos — um normal e um grave — e ninguém conseguia distinguir depois.
     * `semCobranca` no registro é o que separa os dois.
     */
    const c = await cenario("sem-cobranca");
    const a = await analiseTravada(c.org.id, c.user.id);

    const r = await destravarSeAbandonada(a.id);

    expect(r.creditosEstornados).toBe(0);
    const registro = await prisma.auditLog.findFirstOrThrow({
      where: { action: "analysis.execucao_abandonada", entityId: a.id },
    });
    expect((registro.metadata as Record<string, unknown>).semCobranca).toBe(true);
  });

  it("⚠️ estorno que FALHA dispara alerta — antes era engolido em silêncio", async () => {
    /**
     * Era `.catch(() => null)`: o cliente pagava por uma análise que não recebeu, o crédito não voltava, e
     * nada acusava. A análise aparecia como erro (o que é esperado) e o crédito faltando não aparecia em
     * lugar nenhum. Não se conserta sozinho.
     */
    const c = await cenario("estorno-falha");
    const a = await analiseTravada(c.org.id, c.user.id);
    await consumirCreditos(c.sub.id, a.id, 1, "Análise");
    controle.estornoExplode = true;

    const r = await destravarSeAbandonada(a.id);

    // A análise É destravada: deixá-la presa somaria um problema ao outro.
    expect(r.destravada).toBe(true);
    expect(r.creditosEstornados).toBe(0);
    expect(alertas.enviados.map((x) => x.tipo)).toContain("credito_nao_estornado_apos_falha");
    /** E o registro distingue: houve falha, não é o caso de "não havia o que devolver". */
    const registro = await prisma.auditLog.findFirstOrThrow({
      where: { action: "analysis.execucao_abandonada", entityId: a.id },
    });
    const meta = registro.metadata as Record<string, unknown>;
    expect(meta.falhaDoEstorno).toBeTruthy();
    expect(meta.semCobranca).toBe(false);
  });
});
