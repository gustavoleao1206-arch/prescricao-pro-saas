import { PLANOS, PACOTES, precoBR } from "../src/lib/planos";
import { prisma } from "../src/lib/db";

/**
 * Alinha o catálogo do BANCO ao catálogo do CÓDIGO (src/lib/planos.ts).
 *
 * ── Por que isto existe ───────────────────────────────────────────────────────
 * A página de planos lê o BANCO em tempo de execução — o admin pode mudar preço
 * sem publicar código. O deploy roda `prisma migrate deploy && node server.js`, e
 * o seed NÃO entra nesse caminho. Resultado: a oferta foi reformulada no código
 * para dois planos (mensal e anual), o site subiu, e a página seguiu
 * anunciando R$ 39,90, R$ 119,90 e R$ 299,90 — porque os planos antigos continuavam
 * `active` e `publicPlan` no banco de produção.
 *
 * Rodar o seed inteiro resolveria, mas ele semeia muito mais coisa (prompts, base
 * de conhecimento, conteúdo do site, usuário admin) e sobrescreveria ajustes feitos
 * pelo painel. Este script faz SÓ o catálogo.
 *
 * ── O que ele nunca faz ───────────────────────────────────────────────────────
 * Nunca apaga plano nem pacote. Plano antigo fica no banco, aposentado: há
 * assinaturas e pagamentos apontando para ele por chave estrangeira, e apagar
 * destruiria o histórico de quem contratou naquela condição. Assinatura ativa em
 * plano aposentado CONTINUA valendo, com o preço e a cota contratados — o script
 * avisa quantas são.
 *
 * Uso (o padrão é simulação; nada é gravado sem --confirmar):
 *   npx tsx scripts/sincronizar-catalogo.ts
 *   npx tsx scripts/sincronizar-catalogo.ts --confirmar
 *   npx tsx scripts/sincronizar-catalogo.ts --boot     ← roda no start do container
 */

const confirmar = process.argv.includes("--confirmar");
const boot = process.argv.includes("--boot");

function cota(monthlyAnalyses: number): string {
  // 0 significa SEM LIMITE no sistema; imprimir "0" diria o oposto.
  return monthlyAnalyses === 0 ? "sem limite" : `${monthlyAnalyses}/mês`;
}

/**
 * Reconciliação de boot — roda a cada start do container.
 *
 * Faz o MÍNIMO necessário para que a vitrine nunca minta, e nada além disso:
 *
 *  1. CRIA plano do catálogo que ainda não existe no banco. É o que conserta um
 *     banco novo (outra instância, ambiente do sócio, restauração de backup) e o
 *     que conserta a produção depois de uma reformulação de oferta.
 *  2. APOSENTA plano público que não está mais no catálogo. Era o defeito real:
 *     a oferta virou dois planos no código, o site subiu, e a página seguiu
 *     vendendo Essencial, Profissional e Escritório porque continuavam `active` e
 *     `publicPlan` no banco de produção.
 *
 * O que ele deliberadamente NÃO faz: mexer em preço, cota ou benefício de plano do
 * catálogo que já existe. Esse campo é do administrador — o painel permite alterar
 * preço sem publicar código, e sobrescrever a cada deploy transformaria uma decisão
 * comercial em algo que "volta sozinho" sem explicação.
 *
 * Nunca falha o boot: erro aqui é registrado e o site sobe. Vitrine desatualizada é
 * ruim; site fora do ar é pior.
 */
async function reconciliarNoBoot() {
  const slugsCatalogo = PLANOS.map((p) => p.slug);
  const existentes = await prisma.plan.findMany({ select: { slug: true } });
  const jaExistem = new Set(existentes.map((p) => p.slug));

  let criados = 0;
  for (const p of PLANOS) {
    if (jaExistem.has(p.slug)) continue;
    await prisma.plan.create({
      data: {
        slug: p.slug,
        name: p.name,
        description: p.description,
        priceCents: p.priceCents,
        period: p.period as never,
        family: p.family,
        highlight: p.highlight,
        contactOnly: p.contactOnly,
        publicPlan: true,
        sortOrder: p.sortOrder,
        benefits: p.benefits,
        monthlyAnalyses: p.monthlyCredits,
        maxUsers: p.maxUsers,
        priorityProcessing: p.priorityProcessing,
        active: true,
        hotmartOfferCodes: [],
        checkoutUrl: null,
      },
    });
    criados++;
    console.log(`[catalogo] plano criado: ${p.slug} (${precoBR(p.priceCents)})`);
  }

  const aposentados = await prisma.plan.updateMany({
    where: { slug: { notIn: slugsCatalogo }, OR: [{ active: true }, { publicPlan: true }] },
    data: { active: false, publicPlan: false, highlight: false, contactOnly: false },
  });
  if (aposentados.count > 0) {
    console.log(`[catalogo] ${aposentados.count} plano(s) fora do catálogo saíram da vitrine (registro preservado).`);
  }

  const pacotesExistentes = new Set((await prisma.creditPack.findMany({ select: { slug: true } })).map((p) => p.slug));
  for (const pk of PACOTES) {
    if (pacotesExistentes.has(pk.slug)) continue;
    await prisma.creditPack.create({
      data: {
        slug: pk.slug,
        name: pk.name,
        credits: pk.credits,
        priceCents: pk.priceCents,
        validityDays: pk.validityDays,
        sortOrder: pk.sortOrder,
        active: true,
      },
    });
    console.log(`[catalogo] crédito avulso criado: ${pk.slug}`);
  }
  await prisma.creditPack.updateMany({
    where: { slug: { notIn: PACOTES.map((p) => p.slug) }, active: true },
    data: { active: false },
  });

  /**
   * DIVERGÊNCIA DE COTA — avisa, não conserta.
   *
   * O boot não sobrescreve cota de plano existente, porque cota é decisão do
   * administrador. Mas uma divergência é diferente das outras: cota 0 no banco
   * significa SEM LIMITE, e se o catálogo passou a ter teto isso é o produto sendo
   * entregue de graça, com os textos anunciando um número que o sistema não aplica.
   * O conserto é uma linha (`sincronizar-catalogo --confirmar`) e precisa estar
   * visível no log do deploy, não descoberto pela margem no fim do mês.
   */
  const divergentes: string[] = [];
  for (const p of PLANOS) {
    const noBanco = await prisma.plan.findUnique({ where: { slug: p.slug }, select: { monthlyAnalyses: true } });
    if (!noBanco) continue;
    if (noBanco.monthlyAnalyses !== p.monthlyCredits) {
      divergentes.push(`${p.slug}: banco ${cota(noBanco.monthlyAnalyses)} × catálogo ${cota(p.monthlyCredits)}`);
    }
  }
  if (divergentes.length > 0) {
    console.log(`[catalogo] ⚠ COTA DIVERGENTE em ${divergentes.length} plano(s):`);
    for (const d of divergentes) console.log(`[catalogo]   ${d}`);
    console.log("[catalogo]   Para alinhar: npx tsx scripts/sincronizar-catalogo.ts --confirmar");
  }

  const vitrine = await prisma.plan.count({ where: { active: true, publicPlan: true } });
  console.log(`[catalogo] vitrine com ${vitrine} plano(s); ${criados} criado(s) neste boot.`);
}

async function main() {
  if (boot) return reconciliarNoBoot();

  const slugsCatalogo = PLANOS.map((p) => p.slug);
  const slugsPacotes = PACOTES.map((p) => p.slug);

  console.log(confirmar ? "MODO: GRAVANDO\n" : "MODO: SIMULAÇÃO (use --confirmar para gravar)\n");

  // ── Antes ──────────────────────────────────────────────────────────────────
  const antes = await prisma.plan.findMany({ orderBy: [{ active: "desc" }, { sortOrder: "asc" }] });
  console.log("PLANOS NO BANCO AGORA:");
  for (const p of antes) {
    const vitrine = p.active && p.publicPlan ? "NA VITRINE" : "oculto";
    console.log(
      `  ${p.slug.padEnd(28)} ${precoBR(p.priceCents).padStart(11)}  ${cota(p.monthlyAnalyses).padEnd(11)} ${vitrine}`,
    );
  }

  const naVitrineIndevidamente = antes.filter(
    (p) => p.active && p.publicPlan && !slugsCatalogo.includes(p.slug),
  );
  if (naVitrineIndevidamente.length > 0) {
    console.log(
      `\n⚠ ${naVitrineIndevidamente.length} plano(s) fora do catálogo estão sendo VENDIDOS na página pública:`,
    );
    for (const p of naVitrineIndevidamente) console.log(`  - ${p.name} (${p.slug}) por ${precoBR(p.priceCents)}`);
  }

  // ── Assinaturas nos planos que vão ser aposentados ─────────────────────────
  const idsAposentar = antes.filter((p) => !slugsCatalogo.includes(p.slug)).map((p) => p.id);
  if (idsAposentar.length > 0) {
    const presas = await prisma.subscription.groupBy({
      by: ["planId", "status"],
      where: { planId: { in: idsAposentar } },
      _count: { _all: true },
    });
    const ativas = presas.filter((g) => g.status === "ATIVA");
    if (ativas.length > 0) {
      console.log("\nAssinaturas ATIVAS em planos que serão aposentados (continuam valendo, nada muda para elas):");
      for (const g of ativas) {
        const plano = antes.find((p) => p.id === g.planId)!;
        console.log(`  - ${plano.name}: ${g._count._all} assinatura(s)`);
      }
    }
  }

  if (!confirmar) {
    console.log("\n── O QUE SERIA FEITO ──");
    for (const p of PLANOS) {
      const existe = antes.find((a) => a.slug === p.slug);
      console.log(
        `  ${existe ? "atualizar" : "CRIAR   "} ${p.slug.padEnd(28)} ${precoBR(p.priceCents).padStart(11)}  ${cota(p.monthlyCredits)}`,
      );
    }
    for (const p of antes.filter((a) => !slugsCatalogo.includes(a.slug) && (a.active || a.publicPlan))) {
      console.log(`  aposentar ${p.slug}`);
    }
    console.log("\nNada foi gravado. Rode de novo com --confirmar.");
    return;
  }

  // ── Gravação: mesmo mapeamento do seed, para não haver dois lugares divergindo ─
  console.log("\n→ Gravando planos do catálogo…");
  for (const p of PLANOS) {
    const dados = {
      name: p.name,
      description: p.description,
      priceCents: p.priceCents,
      period: p.period as never,
      family: p.family,
      highlight: p.highlight,
      contactOnly: p.contactOnly,
      publicPlan: true,
      sortOrder: p.sortOrder,
      benefits: p.benefits,
      monthlyAnalyses: p.monthlyCredits,
      maxUsers: p.maxUsers,
      priorityProcessing: p.priorityProcessing,
      active: true,
      // Sem link fixo de oferta: cada compra gera sessão de checkout na hora.
      hotmartOfferCodes: [],
      checkoutUrl: null,
    };
    await prisma.plan.upsert({ where: { slug: p.slug }, update: dados, create: { slug: p.slug, ...dados } });
    console.log(`  ok ${p.slug}`);
  }

  const aposentados = await prisma.plan.updateMany({
    where: { slug: { notIn: slugsCatalogo } },
    data: { active: false, publicPlan: false, highlight: false, contactOnly: false },
  });
  console.log(`→ ${aposentados.count} plano(s) aposentado(s) (preservados no banco).`);

  console.log("→ Gravando créditos avulsos…");
  for (const pk of PACOTES) {
    const dados = {
      name: pk.name,
      credits: pk.credits,
      priceCents: pk.priceCents,
      validityDays: pk.validityDays,
      sortOrder: pk.sortOrder,
      active: true,
    };
    await prisma.creditPack.upsert({ where: { slug: pk.slug }, update: dados, create: { slug: pk.slug, ...dados } });
    console.log(`  ok ${pk.slug}`);
  }
  const pacotesAposentados = await prisma.creditPack.updateMany({
    where: { slug: { notIn: slugsPacotes } },
    data: { active: false },
  });
  console.log(`→ ${pacotesAposentados.count} pacote(s) aposentado(s).`);

  // ── Depois ─────────────────────────────────────────────────────────────────
  const depois = await prisma.plan.findMany({
    where: { active: true, publicPlan: true },
    orderBy: { sortOrder: "asc" },
  });
  console.log("\nVITRINE FINAL (é isto que a página /planos vai mostrar):");
  for (const p of depois) {
    console.log(`  ${p.name.padEnd(26)} ${precoBR(p.priceCents).padStart(11)}  ${cota(p.monthlyAnalyses)}`);
  }
  if (depois.length !== PLANOS.length) {
    console.log(`\n⚠ Esperado ${PLANOS.length} plano(s) na vitrine, encontrado ${depois.length}. Confira acima.`);
  }
}

main()
  .catch((e) => {
    console.error("[catalogo] erro:", e);
    // No boot, erro NÃO derruba o site: o start do container encadeia com `&&`.
    if (!boot) process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
