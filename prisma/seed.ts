/**
 * Seed de DEMONSTRAÇÃO — dados fictícios apenas para desenvolvimento.
 * ⚠️ NÃO use em produção. Altere/remova as credenciais antes de publicar.
 * As contas de demonstração usam a senha de SEED_DEMO_PASSWORD (ver .env.example).
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROMPTS } from "../src/lib/ai/prompts";
import { CASOS_TESTE } from "../src/lib/legal/casos-teste";
import { PLANOS, PACOTES } from "../src/lib/planos";
import { problemasDoSeed } from "./seed-guarda";

const prisma = new PrismaClient();

async function hash(pw: string) {
  return bcrypt.hash(pw, 12);
}

/** Lê um arquivo da pasta knowledge/ (base de conhecimento injetada no contexto da IA). */
function readKnowledge(file: string): string {
  try {
    return readFileSync(join(process.cwd(), "knowledge", file), "utf8");
  } catch {
    console.warn(`   (aviso) knowledge/${file} não encontrado — usando fallback embutido.`);
    return "";
  }
}

/**
 * Conteúdo editável do site (blocos de texto da vitrine). É necessário tanto em
 * produção quanto em desenvolvimento, por isso fica fora do bloco de dados de
 * demonstração — que é interrompido antes, em produção.
 */
async function semearConteudoSite() {
  console.log("→ Conteúdo do site (blocos editáveis)…");
  await prisma.contentBlock.upsert({
    where: { slug: "home.hero" },
    update: {},
    create: {
      slug: "home.hero",
      data: {
        titulo: "Análise de prescrição e decadência tributária, com apoio de IA",
        subtitulo: "Envie a execução fiscal, receba relatório estruturado e minuta — para revisão do advogado.",
      },
    },
  });
}

async function main() {
  /**
   * ⚠️ SEM VALOR PADRÃO: sem as duas variáveis, o seed RECUSA rodar.
   *
   * Havia `?? "admin@prescricaopro.local"` e `?? "Admin@Demo123"`. Quem rodasse o seed em produção sem
   * definir as variáveis criava um ADMINISTRADOR com senha escrita no repositório — e a senha viaja
   * dentro da imagem publicada, então "o repositório é privado" não protege.
   *
   * Recusar é o comportamento certo: um seed que falha custa trinta segundos, e um admin com senha
   * conhecida custa o sistema inteiro. Para semear, defina SEED_ADMIN_EMAIL e SEED_ADMIN_PASSWORD.
   */
  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  const adminPass = process.env.SEED_ADMIN_PASSWORD;
  if (!adminEmail || !adminPass) {
    throw new Error(
      "Defina SEED_ADMIN_EMAIL e SEED_ADMIN_PASSWORD antes de rodar o seed. " +
        "Sem elas o seed criaria um administrador com senha padrão — recusado de propósito.",
    );
  }

  // Dados de demonstração: contas com a senha de SEED_DEMO_PASSWORD, escritório
  // fictício, assinatura falsa, análises de exemplo e chamado de suporte.
  //
  // NUNCA em produção. Lá, essas três contas seriam portas de entrada com senha
  // de demonstração — e uma delas é REVISOR, papel que enxerga análise de cliente.
  // Em produção o seed semeia apenas o que a aplicação precisa para funcionar:
  // planos, prompts, base de conhecimento com conteúdo, o administrador real e
  // o conteúdo editável do site.
  //
  // Padrão: demonstração fora de produção. Para suprimir mesmo em
  // desenvolvimento, SEED_DEMO=false. Em produção SEED_DEMO=true é recusado
  // pela trava abaixo.
  const producao = process.env.NODE_ENV === "production";
  const semearDemo = process.env.SEED_DEMO !== undefined ? process.env.SEED_DEMO === "true" : !producao;

  /**
   * ⚠️ Antes de QUALQUER escrita no banco: em produção, recusa senha de demonstração, senha fraca para o
   * administrador e as contas de demonstração. Regras e motivo em prisma/seed-guarda.ts.
   *
   * Tem de vir antes dos planos: falhar no meio deixaria o banco semeado pela metade.
   */
  const problemas = problemasDoSeed({ producao, senhaAdmin: adminPass, semearDemo });
  if (problemas.length > 0) {
    throw new Error(`Seed recusado em produção:\n- ${problemas.join("\n- ")}`);
  }

  /**
   * Senha das contas de demonstração: também SEM valor padrão.
   *
   * As três contas (cliente, revisor e suporte) só nascem fora de produção, mas uma delas é REVISOR, papel
   * que lê análise de cliente. Senha escrita no código é senha pública; por isso ela vem de
   * SEED_DEMO_PASSWORD, e sem ela o seed recusa criar a demonstração (SEED_DEMO=false a dispensa).
   */
  const senhaDemo = process.env.SEED_DEMO_PASSWORD ?? "";
  if (semearDemo && !senhaDemo) {
    throw new Error(
      "Defina SEED_DEMO_PASSWORD antes de rodar o seed (ou SEED_DEMO=false para não criar as contas de demonstração).",
    );
  }

  console.log("→ Semeando planos…");
  // Catálogo comercial vem de src/lib/planos.ts — mesmo arquivo que a página de
  // vendas lê, para que preço anunciado e preço cobrado não possam divergir.
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
      /**
       * Nada de link fixo nem de código de oferta.
       *
       * O pagamento é pelo Asaas: cada compra gera uma sessão de checkout na hora,
       * amarrada à conta pelo `externalReference`. Link fixo compartilhado não
       * carrega quem está comprando, e era assim que a integração anterior
       * (descontinuada) identificava o plano. Os dois campos são zerados de
       * propósito, para não sobrar link antigo ativo em plano nenhum.
       */
      hotmartOfferCodes: [],
      checkoutUrl: null,
    };
    await prisma.plan.upsert({ where: { slug: p.slug }, update: dados, create: { slug: p.slug, ...dados } });
  }

  /**
   * Planos antigos: PRESERVADOS, nunca apagados.
   *
   * Podem estar referenciados por assinaturas e pagamentos — apagar quebraria a
   * chave estrangeira e, pior, destruiria o histórico de quem contratou naquela
   * condição. Ficam apenas fora da vitrine e fechados para novas vendas.
   *
   * A lista deixou de ser fixa: qualquer plano no banco que NÃO esteja no catálogo
   * atual é aposentado. A oferta foi reformulada de quatro faixas escalonadas por
   * crédito para um plano único sem limite, e manter nomes soltos aqui faria uma
   * faixa esquecida continuar vendável na página de planos.
   */
  const slugsAtuais = PLANOS.map((p) => p.slug);
  const aposentados = await prisma.plan.updateMany({
    where: { slug: { notIn: slugsAtuais } },
    data: { active: false, publicPlan: false, highlight: false, contactOnly: false },
  });
  if (aposentados.count > 0) {
    console.log(`→ ${aposentados.count} plano(s) fora do catálogo atual foram aposentados (preservados no banco).`);
  }

  console.log("→ Semeando créditos avulsos…");
  for (const pk of PACOTES) {
    await prisma.creditPack.upsert({
      where: { slug: pk.slug },
      update: { name: pk.name, credits: pk.credits, priceCents: pk.priceCents, validityDays: pk.validityDays, sortOrder: pk.sortOrder, active: true },
      create: { slug: pk.slug, name: pk.name, credits: pk.credits, priceCents: pk.priceCents, validityDays: pk.validityDays, sortOrder: pk.sortOrder, active: true },
    });
  }

  // Pacotes antigos (3/5/10): PRESERVADOS no banco (podem estar referenciados
  // por pagamentos), mas fora da vitrine — a venda avulsa agora é unitária.
  await prisma.creditPack.updateMany({
    where: { slug: { notIn: PACOTES.map((pk) => pk.slug) } },
    data: { active: false },
  });

  /**
   * O plano de referência sai do CATÁLOGO, não de um slug escrito aqui.
   *
   * Estava fixo em "profissional-mensal", plano que a reformulação da oferta
   * extinguiu. Em banco já existente o registro sobrevive aposentado e o
   * `findUniqueOrThrow` passa por acidente; num banco novo — outra instância,
   * ambiente do sócio, restauração de backup — o seed quebraria aqui, no meio,
   * depois de já ter gravado planos e pacotes. Ler do catálogo mantém a demo
   * apontando para a oferta vigente sem manutenção manual.
   */
  const slugPrincipal = (PLANOS.find((p) => p.period === "MENSAL") ?? PLANOS[0]!).slug;
  const planoPrincipal = await prisma.plan.findUniqueOrThrow({ where: { slug: slugPrincipal } });

  console.log("→ Semeando prompts (instruções da IA)…");
  // 1) Prompts padrão embutidos (src/lib/ai/prompts.ts).
  for (const dp of DEFAULT_PROMPTS) {
    await prisma.promptVersion.upsert({
      where: { kind_version: { kind: dp.kind as never, version: dp.version } },
      update: { content: dp.content, label: dp.label, active: true },
      create: { kind: dp.kind as never, version: dp.version, label: dp.label, content: dp.content, active: true },
    });
  }

  // 2) Base de conhecimento com CONTEÚDO (injetada no contexto da IA): um documento por matéria,
  //    lido de knowledge/. Nesta versão pública os arquivos são exemplos curtos — a base real do
  //    produto é proprietária e não acompanha o código.
  const BASE_POR_MATERIA = [
    { id: "kb-prescricao-intercorrente", arquivo: "prescricao-intercorrente.md", title: "Prescrição intercorrente (art. 40 da LEF) — exemplo", category: "LEI_EXECUCOES_FISCAIS", theme: "intercorrente" },
    { id: "kb-prescricao-ordinaria", arquivo: "prescricao-ordinaria.md", title: "Prescrição ordinária (art. 174 do CTN) — exemplo", category: "CODIGO_TRIBUTARIO_NACIONAL", theme: "prescrição" },
    { id: "kb-decadencia-tributaria", arquivo: "decadencia-tributaria.md", title: "Decadência tributária (arts. 150, §4º, e 173 do CTN) — exemplo", category: "CODIGO_TRIBUTARIO_NACIONAL", theme: "decadência" },
  ] as const;
  for (const k of BASE_POR_MATERIA) {
    const content = readKnowledge(k.arquivo);
    if (!content) continue;
    await prisma.knowledgeDocument.upsert({
      where: { id: k.id },
      update: { content, active: true },
      create: { id: k.id, title: k.title, category: k.category as never, theme: k.theme, version: "exemplo", source: "Exemplo público (a base real é proprietária)", active: true, content },
    });
  }

  console.log("→ Semeando usuários…");
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      name: "Administrador Demo",
      role: "ADMIN",
      status: "ATIVO",
      emailVerifiedAt: new Date(),
      passwordHash: await hash(adminPass),
    },
  });

  if (!semearDemo) {
    await semearConteudoSite();
    console.log("\n✅ Seed de produção concluído — sem dados de demonstração.");
    console.log("   Administrador:", adminEmail);
    console.log("   Nenhuma conta de demonstração foi criada.");
    return;
  }

  const revisor = await prisma.user.upsert({
    where: { email: "revisor@prescricaopro.local" },
    update: {},
    create: {
      email: "revisor@prescricaopro.local",
      name: "Dra. Revisora Demo",
      role: "REVISOR",
      status: "ATIVO",
      emailVerifiedAt: new Date(),
      passwordHash: await hash(senhaDemo),
    },
  });

  await prisma.user.upsert({
    where: { email: "suporte@prescricaopro.local" },
    update: {},
    create: {
      email: "suporte@prescricaopro.local",
      name: "Suporte Demo",
      role: "SUPORTE",
      status: "ATIVO",
      emailVerifiedAt: new Date(),
      passwordHash: await hash(senhaDemo),
    },
  });

  const cliente = await prisma.user.upsert({
    where: { email: "cliente@prescricaopro.local" },
    update: {},
    create: {
      email: "cliente@prescricaopro.local",
      name: "Dr. Cliente Demonstração",
      role: "CLIENTE",
      status: "ATIVO",
      emailVerifiedAt: new Date(),
      passwordHash: await hash(senhaDemo),
    },
  });

  console.log("→ Organização e assinatura do cliente…");
  let org = await prisma.organization.findFirst({ where: { ownerId: cliente.id } });
  if (!org) {
    org = await prisma.organization.create({ data: { name: "Escritório Demonstração", ownerId: cliente.id } });
    await prisma.user.update({ where: { id: cliente.id }, data: { organizationId: org.id, orgRole: "OWNER" } });
  }

  // Idempotente: reaproveita a assinatura demo existente (evita duplicar a cada seed).
  const periodEnd = new Date(Date.now() + 30 * 86_400_000);
  const comuns = {
    planId: planoPrincipal.id,
    status: "ATIVA" as const,
    provider: "MANUAL" as const,
    amountCents: planoPrincipal.priceCents,
    currentPeriodEnd: periodEnd,
    // Ciclo de CRÉDITOS: mensal mesmo quando o plano é anual.
    cycleEndsAt: new Date(Date.now() + 30 * 86_400_000),
    /**
     * ⚠️ NULO, e isto não é detalhe: a assinatura demo é `provider: "MANUAL"`.
     *
     * `nextRenewalAt` preenchido significa "esta assinatura se cobra sozinha". Em venda MANUAL não existe
     * quem execute a cobrança, então a data prometia uma renovação que ninguém faz e fazia a varredura
     * diária deixar de encerrar o ciclo — inflando o faturamento declarado para sempre. É invariante
     * registrada no CONTRIBUTING.md, e o seed a violava.
     *
     * Encontrado por `scripts/verificar-restauracao.ts` na primeira vez que ele rodou. Em desenvolvimento
     * o prejuízo era pequeno, mas o seed é o exemplo de referência do projeto: ele estava ensinando a
     * forma errada a quem lê e a quem copiar daqui.
     */
    nextRenewalAt: null,
    creditsReleasedAt: new Date(),
    analysesQuota: planoPrincipal.monthlyAnalyses,
    maxUsers: planoPrincipal.maxUsers,
  };
  let sub = await prisma.subscription.findFirst({ where: { organizationId: org.id }, orderBy: { createdAt: "desc" } });
  if (!sub) {
    sub = await prisma.subscription.create({
      data: { organizationId: org.id, ...comuns, analysesUsed: 1 },
    });
  } else {
    // A conta demo vinha do plano antigo, sem limite de créditos. Fixa o consumo
    // num valor que ilustra bem o painel (a especificação usa "5 de 8
    // disponíveis" como exemplo) em vez de herdar o acumulado do plano ilimitado,
    // que estouraria a cota nova de 8 e abriria a conta sem saldo.
    const usadosDemo = Math.min(3, Math.max(0, planoPrincipal.monthlyAnalyses - 1));
    sub = await prisma.subscription.update({
      where: { id: sub.id },
      data: { ...comuns, analysesUsed: usadosDemo },
    });
  }

  // Extrato de créditos da conta demo, para a tela de histórico não abrir vazia.
  // Idempotente pelas chaves: reexecutar o seed não duplica as linhas.
  const cota = planoPrincipal.monthlyAnalyses;
  const usados = sub.analysesUsed;
  await prisma.creditLedger.upsert({
    where: { idempotencyKey: `seed:${sub.id}:liberacao` },
    update: {},
    create: {
      subscriptionId: sub.id,
      kind: "ASSINATURA",
      bucket: "MENSAL",
      quantity: cota,
      balanceBefore: 0,
      balanceAfter: cota,
      description: `Créditos liberados pela assinatura — plano ${planoPrincipal.name}`,
      idempotencyKey: `seed:${sub.id}:liberacao`,
    },
  });
  if (usados > 0) {
    await prisma.creditLedger.upsert({
      where: { idempotencyKey: `seed:${sub.id}:consumo-demo` },
      update: {},
      create: {
        subscriptionId: sub.id,
        kind: "CONSUMO",
        bucket: "MENSAL",
        quantity: -usados,
        balanceBefore: cota,
        balanceAfter: cota - usados,
        description: "Análise jurídica (demonstração)",
        idempotencyKey: `seed:${sub.id}:consumo-demo`,
      },
    });
  }

  const existingPayment = await prisma.payment.findFirst({ where: { subscriptionId: sub.id } });
  if (!existingPayment) {
    await prisma.payment.create({
      data: { subscriptionId: sub.id, provider: "MANUAL", status: "APROVADO", amountCents: planoPrincipal.priceCents, method: "cartao", paidAt: new Date() },
    });
  }

  console.log("→ Base de conhecimento (exemplos)…");
  const kb = [
    { title: "CTN — art. 174 (prescrição)", category: "CODIGO_TRIBUTARIO_NACIONAL", theme: "prescrição" },
    { title: "CTN — arts. 173 e 150 §4º (decadência)", category: "CODIGO_TRIBUTARIO_NACIONAL", theme: "decadência" },
    { title: "LEF — art. 40 (intercorrente)", category: "LEI_EXECUCOES_FISCAIS", theme: "intercorrente" },
    { title: "Súmula 314/STJ", category: "SUMULAS", theme: "intercorrente" },
    { title: "STJ — Tema 566 (rito do art. 40)", category: "TEMAS_REPETITIVOS", theme: "intercorrente" },
    { title: "Modelo — Petição de prescrição", category: "MODELOS_PECAS", theme: "modelos" },
  ] as const;
  for (const k of kb) {
    await prisma.knowledgeDocument.create({
      data: { title: k.title, category: k.category as never, theme: k.theme, source: "Base pública (demonstração)", active: true },
    });
  }

  console.log("→ Análise fictícia completa…");
  const analysis = await prisma.analysis.create({
    data: {
      organizationId: org.id,
      ownerId: cliente.id,
      title: "Execução Fiscal — Município X (demonstração)",
      type: "PRESCRICAO_INTERCORRENTE",
      status: "CONCLUIDA",
      objective: "Verificar prescrição intercorrente (art. 40 LEF).",
      processNumber: "0001234-56.2011.8.26.0000",
      court: "TJXX",
      creditor: "Município Fictício de Exemplo",
      debtor: "Empresa Demonstração LTDA",
      taxType: "IPTU",
      confidence: "MEDIO",
      completedAt: new Date(),
      facts: {
        dataConstituicaoDefinitiva: "2010-01-15",
        dataAjuizamento: "2011-03-10",
        dataDespachoCitatorio: "2011-04-01",
        dataCitacao: "2012-06-20",
        possuiArquivamento: true,
      },
    },
  });

  await prisma.timelineEvent.createMany({
    data: [
      { analysisId: analysis.id, dateText: "15/01/2010", type: "CONSTITUICAO_CREDITO", nature: "FATO_CONFIRMADO", description: "Constituição definitiva do crédito.", legalEffect: "Início do prazo do art. 174 CTN" },
      { analysisId: analysis.id, dateText: "10/03/2011", type: "AJUIZAMENTO", nature: "FATO_CONFIRMADO", description: "Ajuizamento da execução fiscal." },
      { analysisId: analysis.id, dateText: "01/04/2011", type: "DESPACHO_CITATORIO", nature: "FATO_CONFIRMADO", description: "Despacho que ordena a citação.", legalEffect: "Marco interruptivo (art. 174, § único, I)" },
      { analysisId: analysis.id, dateText: "20/06/2012", type: "CITACAO", nature: "FATO_CONFIRMADO", description: "Citação da executada." },
    ],
  });

  await prisma.report.create({
    data: {
      analysisId: analysis.id,
      version: 1,
      confidence: "MEDIO",
      content: { mode: "demonstracao" },
      markdown:
        "# Relatório de Análise — Execução Fiscal (demonstração)\n\n> Exemplo fictício para fins de demonstração.\n\n## Conclusão\nHá indícios a serem confirmados quanto à prescrição intercorrente (art. 40 LEF). Revisão por advogado(a) obrigatória.",
      aiModel: "demonstracao",
    },
  });

  await prisma.petition.create({
    data: {
      analysisId: analysis.id,
      type: "PRESCRICAO_INTERCORRENTE",
      version: 1,
      title: "Minuta — Prescrição intercorrente (demonstração)",
      markdown: "# Minuta (demonstração)\n\n[INFORMAÇÃO NÃO LOCALIZADA — PREENCHER]\n\n> Minuta gerada automaticamente. Revisão obrigatória por advogado(a).",
      aiModel: "demonstracao",
    },
  });

  await prisma.legalReview.upsert({
    where: { analysisId: analysis.id },
    update: {},
    create: { analysisId: analysis.id, reviewerId: revisor.id, status: "PENDENTE" },
  });

  console.log("→ Casos de teste comparativos (rascunhos prontos para processar)…");
  for (const caso of CASOS_TESTE) {
    const existente = await prisma.analysis.findFirst({ where: { organizationId: org.id, title: caso.titulo } });
    if (existente) continue;
    await prisma.analysis.create({
      data: {
        organizationId: org.id,
        ownerId: cliente.id,
        title: caso.titulo,
        type: caso.identificacao.type as never,
        status: "RASCUNHO",
        objective: caso.identificacao.objective,
        processNumber: caso.identificacao.processNumber,
        court: caso.identificacao.court,
        creditor: caso.identificacao.creditor,
        debtor: caso.identificacao.debtor,
        taxType: caso.identificacao.taxType,
        facts: caso.facts,
      },
    });
  }

  console.log("→ Chamado de suporte fictício…");
  const ticket = await prisma.supportTicket.create({
    data: { requesterId: cliente.id, subject: "Dúvida sobre upload de PDF", category: "documentos", priority: "MEDIA", status: "ABERTO" },
  });
  await prisma.supportMessage.create({
    data: { ticketId: ticket.id, authorId: cliente.id, body: "Qual o tamanho máximo de arquivo aceito?" },
  });

  await semearConteudoSite();

  console.log("\n✅ Seed concluído.");
  // A senha do administrador é a escolhida em SEED_ADMIN_PASSWORD: não vai para a saída, que pode acabar em log.
  console.log("   Admin:   ", adminEmail, "/ (senha de SEED_ADMIN_PASSWORD)");
  console.log("   Cliente: ", "cliente@prescricaopro.local", "/ (senha de SEED_DEMO_PASSWORD)");
  console.log("   Revisor: ", "revisor@prescricaopro.local", "/ (senha de SEED_DEMO_PASSWORD)");
  console.log("   Suporte: ", "suporte@prescricaopro.local", "/ (senha de SEED_DEMO_PASSWORD)");
  console.log("   ⚠️  Altere/remova estas credenciais antes de publicar.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
