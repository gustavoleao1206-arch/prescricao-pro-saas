import { prisma } from "../db";

/**
 * Custo de API por análise.
 *
 * A Leão Amorim paga por token; o cliente paga por crédito. Sem esta medição não
 * há como saber se um plano dá lucro ou prejuízo — que é a diferença entre um
 * preço escolhido e um preço adivinhado.
 *
 * O cliente NUNCA vê estes números: a especificação é explícita em que ele
 * enxerga créditos, não tokens.
 */

/** Preço por 1 milhão de tokens, em dólares. Conferir na página do provedor. */
export interface PrecoModelo {
  entradaUsdPorMilhao: number;
  saidaUsdPorMilhao: number;
}

/**
 * Tabela de preços. Atualize aqui quando o provedor mudar o preço — é o único
 * ponto do sistema que precisa saber disso.
 *
 * Conferido em julho/2026. Modelo desconhecido cai no `padrao`, que é
 * deliberadamente caro: é melhor superestimar o custo do que descobrir tarde
 * que a margem era negativa.
 */
export const PRECOS: Record<string, PrecoModelo> = {
  "gpt-4o": { entradaUsdPorMilhao: 2.5, saidaUsdPorMilhao: 10 },
  "gpt-4o-mini": { entradaUsdPorMilhao: 0.15, saidaUsdPorMilhao: 0.6 },
  "claude-opus-4-8": { entradaUsdPorMilhao: 5, saidaUsdPorMilhao: 25 },
  "claude-sonnet-5": { entradaUsdPorMilhao: 3, saidaUsdPorMilhao: 15 },
  "claude-haiku-4-5": { entradaUsdPorMilhao: 1, saidaUsdPorMilhao: 5 },
  padrao: { entradaUsdPorMilhao: 5, saidaUsdPorMilhao: 25 },
};

/** Câmbio usado na estimativa. Ajustável por variável de ambiente. */
export function cotacaoDolar(): number {
  const bruto = Number(process.env.USD_BRL ?? "");
  return Number.isFinite(bruto) && bruto > 0 ? bruto : 5.6;
}

/** Custo estimado em centavos de real. */
export function custoEmCentavos(modelo: string, tokensEntrada: number, tokensSaida: number): number {
  const preco = PRECOS[modelo] ?? PRECOS.padrao!;
  const usd =
    (tokensEntrada / 1_000_000) * preco.entradaUsdPorMilhao +
    (tokensSaida / 1_000_000) * preco.saidaUsdPorMilhao;
  return Math.round(usd * cotacaoDolar() * 100);
}

export interface RegistroUso {
  analysisId?: string | null;
  organizationId?: string | null;
  subscriptionId?: string | null;
  userId?: string | null;
  planSlug?: string | null;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  calls?: number;
  durationMs?: number;
  pageCount?: number;
  fileBytes?: number;
  creditsCharged?: number;
  reprocess?: boolean;
  errored?: boolean;
  errorMessage?: string;
}

/**
 * Grava o consumo de API de uma análise.
 *
 * Nunca lança: uma falha ao registrar custo não pode derrubar uma análise que o
 * cliente já pagou. O erro vai para o log e a análise segue.
 */
export async function registrarUsoIA(uso: RegistroUso): Promise<void> {
  try {
    const inputTokens = uso.inputTokens ?? 0;
    const outputTokens = uso.outputTokens ?? 0;
    await prisma.aiUsageRecord.create({
      data: {
        analysisId: uso.analysisId ?? null,
        organizationId: uso.organizationId ?? null,
        subscriptionId: uso.subscriptionId ?? null,
        userId: uso.userId ?? null,
        planSlug: uso.planSlug ?? null,
        provider: uso.provider,
        model: uso.model,
        inputTokens,
        outputTokens,
        costCents: custoEmCentavos(uso.model, inputTokens, outputTokens),
        calls: uso.calls ?? 1,
        durationMs: uso.durationMs ?? null,
        pageCount: uso.pageCount ?? null,
        fileBytes: uso.fileBytes ?? null,
        creditsCharged: uso.creditsCharged ?? 0,
        reprocess: uso.reprocess ?? false,
        errored: uso.errored ?? false,
        errorMessage: uso.errorMessage ?? null,
      },
    });
  } catch (err) {
    console.error("[custos] falha ao registrar uso de IA:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Indicadores administrativos
// ---------------------------------------------------------------------------

export interface IndicadoresPeriodo {
  analises: number;
  custoTotalCents: number;
  custoMedioCents: number;
  tokensEntrada: number;
  tokensSaida: number;
  erros: number;
  reprocessos: number;
  creditosConsumidos: number;
  porPlano: Array<{
    planSlug: string;
    analises: number;
    custoTotalCents: number;
    custoMedioCents: number;
  }>;
}

export async function indicadoresDeCusto(desde: Date, ate: Date = new Date()): Promise<IndicadoresPeriodo> {
  const registros = await prisma.aiUsageRecord.findMany({
    where: { createdAt: { gte: desde, lte: ate } },
    select: {
      planSlug: true,
      costCents: true,
      inputTokens: true,
      outputTokens: true,
      errored: true,
      reprocess: true,
      creditsCharged: true,
      analysisId: true,
    },
  });

  const analisesDistintas = new Set(registros.map((r) => r.analysisId).filter(Boolean)).size;
  const custoTotalCents = registros.reduce((s, r) => s + r.costCents, 0);

  const agrupado = new Map<string, { analises: Set<string>; custo: number }>();
  for (const r of registros) {
    const chave = r.planSlug ?? "sem-plano";
    const atual = agrupado.get(chave) ?? { analises: new Set<string>(), custo: 0 };
    if (r.analysisId) atual.analises.add(r.analysisId);
    atual.custo += r.costCents;
    agrupado.set(chave, atual);
  }

  return {
    analises: analisesDistintas,
    custoTotalCents,
    custoMedioCents: analisesDistintas > 0 ? Math.round(custoTotalCents / analisesDistintas) : 0,
    tokensEntrada: registros.reduce((s, r) => s + r.inputTokens, 0),
    tokensSaida: registros.reduce((s, r) => s + r.outputTokens, 0),
    erros: registros.filter((r) => r.errored).length,
    reprocessos: registros.filter((r) => r.reprocess).length,
    creditosConsumidos: registros.reduce((s, r) => s + r.creditsCharged, 0),
    porPlano: [...agrupado.entries()]
      .map(([planSlug, v]) => ({
        planSlug,
        analises: v.analises.size,
        custoTotalCents: v.custo,
        custoMedioCents: v.analises.size > 0 ? Math.round(v.custo / v.analises.size) : 0,
      }))
      .sort((a, b) => b.custoTotalCents - a.custoTotalCents),
  };
}

export interface IndicadoresReceita {
  assinaturasAtivas: number;
  receitaRecorrenteMensalCents: number;
  inadimplentes: number;
  canceladas: number;
  estornadas: number;
  porPlano: Array<{
    planSlug: string;
    planName: string;
    assinaturas: number;
    receitaMensalCents: number;
    /** Custo de UMA análise, em média. */
    custoMedioCents: number;
    /** Custo de API que um assinante deste plano gera no período. */
    custoPorAssinanteCents: number;
    analisesPorAssinante: number;
    margemEstimadaCents: number;
  }>;
}

/**
 * Receita e margem por plano.
 *
 * A receita recorrente do plano anual é dividida por 12 para ficar comparável
 * com a do mensal — sem isso um cliente anual apareceria como doze meses de
 * receita num mês só e a margem daquele mês ficaria irreal.
 */
export async function indicadoresDeReceita(desde: Date): Promise<IndicadoresReceita> {
  const [assinaturas, custos] = await Promise.all([
    prisma.subscription.findMany({
      where: { status: { in: ["ATIVA", "TESTE", "INADIMPLENTE", "SUSPENSA", "CANCELADA", "ESTORNADA"] } },
      include: { plan: { select: { slug: true, name: true, period: true } } },
    }),
    indicadoresDeCusto(desde),
  ]);

  const custoPorPlano = new Map(custos.porPlano.map((p) => [p.planSlug, p]));
  const ativas = assinaturas.filter((s) => s.status === "ATIVA" || s.status === "TESTE");

  const mensalizar = (centavos: number, periodo: string) =>
    periodo === "ANUAL" ? Math.round(centavos / 12) : centavos;

  const porPlano = new Map<string, { name: string; assinaturas: number; receita: number }>();
  for (const s of ativas) {
    const atual = porPlano.get(s.plan.slug) ?? { name: s.plan.name, assinaturas: 0, receita: 0 };
    atual.assinaturas += 1;
    atual.receita += mensalizar(s.amountCents, s.plan.period);
    porPlano.set(s.plan.slug, atual);
  }

  return {
    assinaturasAtivas: ativas.length,
    receitaRecorrenteMensalCents: [...porPlano.values()].reduce((s, p) => s + p.receita, 0),
    inadimplentes: assinaturas.filter((s) => s.status === "INADIMPLENTE" || s.status === "SUSPENSA").length,
    canceladas: assinaturas.filter((s) => s.status === "CANCELADA").length,
    estornadas: assinaturas.filter((s) => s.status === "ESTORNADA").length,
    porPlano: [...porPlano.entries()]
      .map(([slug, v]) => {
        const uso = custoPorPlano.get(slug);
        const receitaMedia = v.assinaturas > 0 ? Math.round(v.receita / v.assinaturas) : 0;

        /**
         * A margem tem de descontar o que o assinante consome DE FATO, não o
         * custo de uma análise avulsa.
         *
         * Um assinante do Profissional roda até 8 análises por mês: comparar a
         * mensalidade com o custo de UMA delas mostraria margem folgada em plano
         * que dá prejuízo. Aqui o custo total do plano no período é dividido
         * pelo número de assinantes, que é o custo real por cliente.
         */
        const custoPorAssinante =
          uso && v.assinaturas > 0 ? Math.round(uso.custoTotalCents / v.assinaturas) : 0;
        const analisesPorAssinante =
          uso && v.assinaturas > 0 ? Number((uso.analises / v.assinaturas).toFixed(1)) : 0;

        return {
          planSlug: slug,
          planName: v.name,
          assinaturas: v.assinaturas,
          receitaMensalCents: v.receita,
          custoMedioCents: uso?.custoMedioCents ?? 0,
          custoPorAssinanteCents: custoPorAssinante,
          analisesPorAssinante,
          margemEstimadaCents: receitaMedia - custoPorAssinante,
        };
      })
      .sort((a, b) => b.receitaMensalCents - a.receitaMensalCents),
  };
}

/** Clientes que mais consomem API no período — para checar abuso e margem. */
export async function maioresConsumidores(desde: Date, limite = 10) {
  const registros = await prisma.aiUsageRecord.groupBy({
    by: ["organizationId"],
    where: { createdAt: { gte: desde }, organizationId: { not: null } },
    _sum: { costCents: true, creditsCharged: true },
    _count: { _all: true },
    orderBy: { _sum: { costCents: "desc" } },
    take: limite,
  });

  const orgs = await prisma.organization.findMany({
    where: { id: { in: registros.map((r) => r.organizationId!).filter(Boolean) } },
    select: { id: true, name: true },
  });
  const nomePorId = new Map(orgs.map((o) => [o.id, o.name]));

  return registros.map((r) => ({
    organizationId: r.organizationId!,
    nome: nomePorId.get(r.organizationId!) ?? "—",
    chamadas: r._count._all,
    custoCents: r._sum.costCents ?? 0,
    creditos: r._sum.creditsCharged ?? 0,
  }));
}
