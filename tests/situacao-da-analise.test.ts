import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { PrismaClient, AnalysisStatus } from "@prisma/client";

/**
 * Cancelar, arquivar, desarquivar e forçar situação de uma análise.
 *
 * ── O defeito que este arquivo cobre ──────────────────────────────────────────
 * `CANCELADA`, `ARQUIVADA` e `EM_REVISAO` existiam no banco, tinham selo colorido em
 * `components/ui/badge.tsx` e apareciam nos manuais PUBLICADOS do produto — e nenhum caminho do sistema
 * escrevia nenhum deles. A única rota que aceitaria os valores (`PATCH /api/analises/[id]`) não tinha um
 * único chamador, não validava transição e não encostava em crédito.
 *
 * O custo estava no caminho do dinheiro: o cliente com uma análise em ERRO_PROCESSAMENTO e o limite de
 * três reprocessamentos esgotado tinha exatamente uma opção na tela — EXCLUIR, que apaga os documentos e
 * não devolve nada. A única saída oferecida a quem pagou e não recebeu era destruir a prova de que pagou.
 *
 * ── O que os testes travam ────────────────────────────────────────────────────
 * A regra do crédito (devolve quando não houve entrega, não devolve quando houve), a recusa de cancelar
 * execução VIVA, a dedução de para onde o desarquivamento volta, e os dois destinos que "forçar" recusa
 * porque fariam o sistema mentir para o cliente.
 */

const {
  aplicarSituacao,
  podeExecutar,
  forcarSituacao,
  GRUPOS_DE_SITUACAO,
  grupoDaUrl,
} = await import("../src/lib/situacao-da-analise");
const { MINUTOS_SEM_SINAL_DE_VIDA } = await import("../src/lib/analise-travada");

const prisma = new PrismaClient();
const PREFIXO = "test-situacao";

async function limpar() {
  const orgs = await prisma.organization.findMany({ where: { name: { startsWith: PREFIXO } }, select: { id: true } });
  const orgIds = orgs.map((o) => o.id);
  const analises = orgIds.length
    ? await prisma.analysis.findMany({ where: { organizationId: { in: orgIds } }, select: { id: true } })
    : [];
  const ids = analises.map((a) => a.id);
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
  }
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { entityId: { in: userIds } }] } });
  }
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

beforeEach(limpar);

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

/** Conta + organização + assinatura com créditos, o mínimo para haver crédito a devolver. */
async function cenario(sufixo: string, opcoes: { creditos?: number } = {}) {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Cliente ${sufixo}`,
      passwordHash: "x",
      role: "CLIENTE",
      status: "ATIVO",
      emailVerifiedAt: new Date(),
    },
  });
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-${sufixo}`, ownerId: user.id } });
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id, orgRole: "OWNER" } });

  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-${sufixo}`,
      name: `Plano ${sufixo}`,
      priceCents: 3990,
      period: "MENSAL",
      /** `monthlyAnalyses` é o campo do PLANO; `analysesQuota` é o da assinatura. */
      monthlyAnalyses: opcoes.creditos ?? 10,
      maxUsers: 1,
    },
  });
  const sub = await prisma.subscription.create({
    data: {
      organizationId: org.id,
      planId: plano.id,
      status: "ATIVA",
      provider: "MANUAL",
      amountCents: 3990,
      analysesQuota: opcoes.creditos ?? 10,
      analysesUsed: 0,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  return { user, org, sub, plano };
}

async function analise(
  ctx: Awaited<ReturnType<typeof cenario>>,
  dados: Partial<{
    status: "RASCUNHO" | "PROCESSANDO" | "ERRO_PROCESSAMENTO" | "CONCLUIDA" | "CANCELADA" | "ARQUIVADA" | "AGUARDANDO_REVISAO";
    heartbeatAt: Date | null;
    completedAt: Date | null;
    creditsCharged: number;
  }> = {},
) {
  return prisma.analysis.create({
    data: {
      organizationId: ctx.org.id,
      ownerId: ctx.user.id,
      title: `${PREFIXO} análise`,
      status: dados.status ?? "ERRO_PROCESSAMENTO",
      heartbeatAt: dados.heartbeatAt ?? null,
      completedAt: dados.completedAt ?? null,
      creditsCharged: dados.creditsCharged ?? 0,
    },
  });
}

/** Cobrança de verdade na razão: é ela que o estorno procura, não `creditsCharged`. */
async function cobrar(ctx: Awaited<ReturnType<typeof cenario>>, analysisId: string, quantidade = 1) {
  const { consumirCreditos } = await import("../src/lib/credits");
  return consumirCreditos(ctx.sub.id, analysisId, quantidade, "Análise de teste");
}

async function saldoUsado(subId: string) {
  return (await prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).analysesUsed;
}

const ator = (id: string) => ({ id, role: "CLIENTE" as const });

describe("cancelar devolve o crédito de quem pagou e não recebeu", () => {
  it("⚠️ análise em erro, SEM relatório: devolve", async () => {
    /**
     * O caso que abre o beco sem saída. Sem a devolução, cancelar seria o cliente perdendo o dinheiro
     * por iniciativa própria — e era a única alternativa a EXCLUIR, que também não devolve nada.
     */
    const ctx = await cenario("devolve");
    const a = await analise(ctx, { status: "ERRO_PROCESSAMENTO" });
    await cobrar(ctx, a.id);
    expect(await saldoUsado(ctx.sub.id)).toBe(1);

    const r = await aplicarSituacao("cancelar", a, ator(ctx.user.id));

    expect(r.status).toBe("CANCELADA");
    expect(r.creditosDevolvidos).toBe(1);
    expect(await saldoUsado(ctx.sub.id)).toBe(0);
    expect((await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("CANCELADA");
  });

  it("⚠️ COM relatório: não devolve — a apuração foi feita e o provedor já foi pago", async () => {
    /**
     * O outro lado da regra, e sem ele "pedir a análise, ler o relatório e cancelar" viraria análise de
     * graça: o custo da chamada de IA é da Leão Amorim e não volta.
     */
    const ctx = await cenario("nao-devolve");
    const a = await analise(ctx, { status: "AGUARDANDO_REVISAO" });
    await cobrar(ctx, a.id);
    await prisma.report.create({
      data: { analysisId: a.id, version: 1, markdown: "relatório", content: {} },
    });

    const r = await aplicarSituacao("cancelar", a, ator(ctx.user.id));

    expect(r.tinhaRelatorio).toBe(true);
    expect(r.creditosDevolvidos).toBe(0);
    expect(await saldoUsado(ctx.sub.id)).toBe(1);
  });

  it("sem cobrança nenhuma, cancela e não inventa devolução", async () => {
    const ctx = await cenario("sem-cobranca");
    const a = await analise(ctx, { status: "RASCUNHO" });

    const r = await aplicarSituacao("cancelar", a, ator(ctx.user.id));

    expect(r.status).toBe("CANCELADA");
    expect(r.creditosDevolvidos).toBe(0);
    expect(r.creditoJaDevolvido).toBe(false);
  });

  it("⚠️ crédito JÁ devolvido pela varredura é distinguido de 'não havia crédito'", async () => {
    /**
     * Acontece de verdade, e é o caminho mais comum de todos: a varredura de manutenção estorna sozinha
     * a análise cujo processamento morreu. Quando o cliente cancela depois disso, o estorno responde
     * zero — e sem esta distinção a tela dizia "não havia crédito debitado nesta análise", que é falso.
     * A pessoa concluiria que pagou e não recebeu nada de volta, no exato momento em que o dinheiro já
     * estava de volta no saldo dela.
     */
    const ctx = await cenario("ja-devolvido");
    const a = await analise(ctx, { status: "ERRO_PROCESSAMENTO" });
    await cobrar(ctx, a.id);
    const { estornarCreditosDaAnalise } = await import("../src/lib/credits");
    await estornarCreditosDaAnalise(a.id, "varredura de manutenção");
    expect(await saldoUsado(ctx.sub.id)).toBe(0);

    const r = await aplicarSituacao("cancelar", a, ator(ctx.user.id));

    expect(r.creditosDevolvidos).toBe(0);
    expect(r.creditoJaDevolvido).toBe(true);
    // E não devolve em dobro: o saldo continua no mesmo lugar.
    expect(await saldoUsado(ctx.sub.id)).toBe(0);
  });

  it("⚠️ NÃO apaga documento nenhum — é a diferença entre cancelar e excluir", async () => {
    /**
     * Num produto cuja saída vai para processo judicial, apagar quase nunca é a ação certa. Cancelar
     * preserva os documentos que o cliente subiu, o histórico e a possibilidade de o suporte
     * reconstituir o que houve.
     */
    const ctx = await cenario("preserva");
    const a = await analise(ctx);
    await prisma.document.create({
      data: {
        analysisId: a.id,
        organizationId: ctx.org.id,
        filename: "processo.pdf",
        storageKey: `${PREFIXO}/processo.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 1024,
      },
    });

    await aplicarSituacao("cancelar", a, ator(ctx.user.id));

    expect(await prisma.document.count({ where: { analysisId: a.id } })).toBe(1);
    expect(await prisma.analysis.count({ where: { id: a.id } })).toBe(1);
  });

  it("deixa auditoria com o status anterior e o crédito devolvido", async () => {
    const ctx = await cenario("auditoria");
    const a = await analise(ctx, { status: "ERRO_PROCESSAMENTO" });
    await cobrar(ctx, a.id);

    await aplicarSituacao("cancelar", a, ator(ctx.user.id));

    const registro = await prisma.auditLog.findFirstOrThrow({
      where: { action: "analysis.cancelar", entityId: a.id },
    });
    const meta = registro.metadata as Record<string, unknown>;
    expect(meta.statusAnterior).toBe("ERRO_PROCESSAMENTO");
    expect(meta.creditosDevolvidos).toBe(1);
  });
});

describe("execução viva não é cancelada", () => {
  it("⚠️ RECUSA enquanto o motor dá sinal de vida", async () => {
    /**
     * O motor está rodando noutro lugar e vai gravar o status dele ao terminar — sobrescrevendo o
     * CANCELADA. A análise "descancelaria" sozinha minutos depois, e o cliente veria o próprio
     * cancelamento ser desfeito sem explicação.
     */
    const ctx = await cenario("viva");
    const a = await analise(ctx, { status: "PROCESSANDO", heartbeatAt: new Date() });

    const v = podeExecutar("cancelar", a);

    expect(v.pode).toBe(false);
    expect(v.recusa).toBe("execucao_viva");
  });

  it("execução MORTA pode ser cancelada — é onde cancelar tem valor", async () => {
    // Sem sinal de vida, ninguém vai sobrescrever nada e o crédito está preso.
    const ctx = await cenario("morta");
    const a = await analise(ctx, {
      status: "PROCESSANDO",
      heartbeatAt: new Date(Date.now() - (MINUTOS_SEM_SINAL_DE_VIDA + 5) * 60_000),
    });

    expect(podeExecutar("cancelar", a).pode).toBe(true);
  });

  it("análise CONCLUIDA não se cancela — se arquiva", async () => {
    /**
     * Cancelar uma entrega mudaria o selo para "Cancelada" numa análise que o cliente recebeu, usou e
     * talvez tenha protocolado. O histórico dele passaria a mentir.
     */
    const ctx = await cenario("concluida");
    const a = await analise(ctx, { status: "CONCLUIDA", completedAt: new Date() });

    expect(podeExecutar("cancelar", a).recusa).toBe("status_incompativel");
    expect(podeExecutar("arquivar", a).pode).toBe(true);
  });
});

describe("arquivar e desarquivar", () => {
  it("arquivar não move crédito", async () => {
    const ctx = await cenario("arquiva");
    const a = await analise(ctx, { status: "CONCLUIDA", completedAt: new Date() });
    await cobrar(ctx, a.id);

    const r = await aplicarSituacao("arquivar", a, ator(ctx.user.id));

    expect(r.status).toBe("ARQUIVADA");
    expect(r.creditosDevolvidos).toBe(0);
    expect(await saldoUsado(ctx.sub.id)).toBe(1);
  });

  it("desarquivar devolve ao status de ORIGEM, lido da auditoria do arquivamento", async () => {
    /**
     * Se o destino errasse, uma análise entregue voltaria do arquivo marcada como "Cancelada" — e o
     * cliente concluiria que perdeu o resultado. O caminho passa pelo `arquivar` de verdade, porque é
     * ele que grava o registro que o desarquivamento lê.
     */
    const ctx = await cenario("desarquiva");
    const concluida = await analise(ctx, { status: "CONCLUIDA", completedAt: new Date() });
    await aplicarSituacao("arquivar", concluida, ator(ctx.user.id));
    const cancelada = await analise(ctx, { status: "CANCELADA" });
    await aplicarSituacao("arquivar", cancelada, ator(ctx.user.id));

    const voltaConcluida = await aplicarSituacao(
      "desarquivar",
      { ...concluida, status: "ARQUIVADA" },
      ator(ctx.user.id),
    );
    const voltaCancelada = await aplicarSituacao(
      "desarquivar",
      { ...cancelada, status: "ARQUIVADA" },
      ator(ctx.user.id),
    );

    expect(voltaConcluida.status).toBe("CONCLUIDA");
    expect(voltaCancelada.status).toBe("CANCELADA");
  });

  it("⚠️⚠️ análise CANCELADA com `completedAt` preenchido NÃO volta como Concluída", async () => {
    /**
     * ⚠️ ESTE TESTE EXISTE PORQUE A PRIMEIRA VERSÃO ESTAVA ERRADA, E O TESTE ANTERIOR FIXAVA O ERRO.
     *
     * O destino era DEDUZIDO de `completedAt`, com o raciocínio "a data só é preenchida na conclusão".
     * Falso: `analysis-runner.ts` grava a data ao ir para AGUARDANDO_REVISAO, ao FIM DO PROCESSAMENTO, e
     * ninguém a limpa depois. Então este caminho — todo do lado do cliente, sem administrador nenhum —
     * transformava um cancelamento em entrega:
     *
     *   processa e vai a AGUARDANDO_REVISAO (data gravada) → cliente CANCELA → arquiva → desarquiva →
     *   volta com selo verde de CONCLUÍDA, com a revisão jurídica ainda pendente.
     *
     * Num produto cuja saída vai para os autos, o status é prova de diligência: ele passaria a afirmar
     * uma entrega que não houve. E não havia volta, porque cancelar não é permitido a partir de
     * CONCLUIDA. O teste anterior montava ARQUIVADA + data à mão e afirmava exatamente o mapeamento
     * errado — fixava a suposição em vez de testá-la.
     */
    const ctx = await cenario("cancelada-com-data");
    const a = await analise(ctx, { status: "AGUARDANDO_REVISAO", completedAt: new Date() });

    await aplicarSituacao("cancelar", a, ator(ctx.user.id));
    await aplicarSituacao("arquivar", { ...a, status: "CANCELADA" }, ator(ctx.user.id));
    const volta = await aplicarSituacao("desarquivar", { ...a, status: "ARQUIVADA" }, ator(ctx.user.id));

    expect(volta.status).toBe("CANCELADA");
    expect((await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("CANCELADA");
  });

  it("sem registro do arquivamento, o destino é CANCELADA — errar para o lado recuperável", async () => {
    /**
     * Acontece com análises arquivadas antes desta mudança, e se `logAudit` falhar (ele engole o próprio
     * erro). Errar para "cancelada" é recuperável: o cliente reprocessa. Errar para "concluída" afirma
     * uma entrega, e disso não há volta.
     */
    const ctx = await cenario("sem-registro");
    const a = await analise(ctx, { status: "ARQUIVADA", completedAt: new Date() });

    expect((await aplicarSituacao("desarquivar", a, ator(ctx.user.id))).status).toBe("CANCELADA");
  });

  it("arquivar duas vezes é recusado pelo status, não silenciosamente aceito", async () => {
    const ctx = await cenario("duas-vezes");
    const a = await analise(ctx, { status: "ARQUIVADA", completedAt: new Date() });

    expect(podeExecutar("arquivar", a).recusa).toBe("status_incompativel");
  });
});

describe("forçar status recusa o que faria o sistema mentir", () => {
  it("⚠️ CONCLUIDA sem relatório é RECUSADA", async () => {
    /**
     * O selo verde e o texto da tela dizem que a apuração está pronta, e não há nada para ler nem
     * baixar. O cliente é levado a acreditar que recebeu o que pagou.
     */
    const ctx = await cenario("forca-concluida");
    const a = await analise(ctx, { status: "ERRO_PROCESSAMENTO" });

    const r = await forcarSituacao(a, "CONCLUIDA", "cliente pediu por telefone", { id: ctx.user.id, role: "ADMIN" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.recusa).toBe("concluida_sem_relatorio");
    expect((await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("ERRO_PROCESSAMENTO");
  });

  it("CONCLUIDA COM relatório é aceita, e marca a data de conclusão", async () => {
    const ctx = await cenario("forca-ok");
    const a = await analise(ctx, { status: "AGUARDANDO_REVISAO" });
    await prisma.report.create({
      data: { analysisId: a.id, version: 1, markdown: "relatório", content: {} },
    });

    const r = await forcarSituacao(a, "CONCLUIDA", "revisão feita fora do sistema", { id: ctx.user.id, role: "ADMIN" });

    expect(r.ok).toBe(true);
    const depois = await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } });
    expect(depois.status).toBe("CONCLUIDA");
    /**
     * A data acompanha porque o desarquivamento a lê para deduzir a origem: sem ela, desarquivar
     * devolveria esta análise como CANCELADA, invertendo o conserto que o suporte acabou de fazer.
     */
    expect(depois.completedAt).not.toBeNull();
  });

  it("⚠️ status de EXECUÇÃO é RECUSADO — não há motor para executá-lo", async () => {
    /**
     * Forçar PROCESSANDO deixaria a análise assim até a varredura de manutenção derrubá-la meia hora
     * depois — e a varredura tentaria estornar um crédito que talvez nunca tenha sido cobrado. Forçar
     * aqui CRIA a análise travada que a varredura existe para consertar.
     */
    const ctx = await cenario("forca-execucao");
    const a = await analise(ctx, { status: "ERRO_PROCESSAMENTO" });

    for (const destino of ["PROCESSANDO", "EXTRAINDO_INFORMACOES", "VALIDANDO_DOCUMENTOS"] as const) {
      const r = await forcarSituacao(a, destino, "tentando destravar", { id: ctx.user.id, role: "ADMIN" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.recusa).toBe("execucao_sem_motor");
    }
  });

  it("motivo curto é recusado — registro sem razão escrita é rastro sem valor", async () => {
    const ctx = await cenario("forca-motivo");
    const a = await analise(ctx, { status: "ERRO_PROCESSAMENTO" });

    const r = await forcarSituacao(a, "AGUARDANDO_INFORMACOES", "  ok ", { id: ctx.user.id, role: "ADMIN" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.recusa).toBe("motivo_ausente");
  });

  it("⚠️ NÃO move crédito, mesmo com cobrança em aberto", async () => {
    /**
     * Quem força um status está consertando exibição, e dinheiro não se move por efeito colateral de um
     * conserto de tela. Devolver crédito continua sendo ato próprio (cancelar sem entrega).
     */
    const ctx = await cenario("forca-credito");
    const a = await analise(ctx, { status: "ERRO_PROCESSAMENTO" });
    await cobrar(ctx, a.id);

    const r = await forcarSituacao(a, "CANCELADA", "conserto de exibição", { id: ctx.user.id, role: "ADMIN" });

    expect(r.ok).toBe(true);
    // O crédito segue consumido: forçar CANCELADA não é o mesmo que cancelar.
    expect(await saldoUsado(ctx.sub.id)).toBe(1);
  });

  it("destino IGUAL ao atual é recusado", async () => {
    // Sem isto, o registro de auditoria diria "mudou de CANCELADA para CANCELADA": rastro sem sentido.
    const ctx = await cenario("forca-igual");
    const a = await analise(ctx, { status: "ERRO_PROCESSAMENTO" });

    const r = await forcarSituacao(a, "ERRO_PROCESSAMENTO", "só conferindo", { id: ctx.user.id, role: "ADMIN" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.recusa).toBe("destino_igual");
  });

  it("⚠️ análise em execução VIVA é recusada — o motor sobrescreveria o conserto", async () => {
    /**
     * A outra recusa cuida do DESTINO ser de execução; esta cuida da ORIGEM, e faltava. O motor está
     * rodando noutro lugar e grava o status dele ao terminar: o suporte veria a alteração "dar certo" e
     * ser desfeita minutos depois, sem nada explicando — e tentaria de novo.
     */
    const ctx = await cenario("forca-viva");
    const a = await analise(ctx, { status: "PROCESSANDO", heartbeatAt: new Date() });

    const r = await forcarSituacao(a, "ERRO_PROCESSAMENTO", "cliente reclamou da demora", {
      id: ctx.user.id,
      role: "ADMIN",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.recusa).toBe("execucao_viva");
    expect((await prisma.analysis.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("PROCESSANDO");
  });

  it("execução MORTA pode ser forçada — é onde a ferramenta serve", async () => {
    const ctx = await cenario("forca-morta");
    const a = await analise(ctx, {
      status: "PROCESSANDO",
      heartbeatAt: new Date(Date.now() - (MINUTOS_SEM_SINAL_DE_VIDA + 5) * 60_000),
    });

    const r = await forcarSituacao(a, "ERRO_PROCESSAMENTO", "processamento morreu no deploy", {
      id: ctx.user.id,
      role: "ADMIN",
    });

    expect(r.ok).toBe(true);
  });

  it("o motivo fica na auditoria", async () => {
    const ctx = await cenario("forca-auditoria");
    const a = await analise(ctx, { status: "ERRO_PROCESSAMENTO" });

    await forcarSituacao(a, "AGUARDANDO_INFORMACOES", "cliente vai reenviar a CDA legível", {
      id: ctx.user.id,
      role: "ADMIN",
    });

    const registro = await prisma.auditLog.findFirstOrThrow({
      where: { action: "analysis.status_forcado", entityId: a.id },
    });
    const meta = registro.metadata as Record<string, unknown>;
    expect(meta.motivo).toBe("cliente vai reenviar a CDA legível");
    expect(meta.statusAnterior).toBe("ERRO_PROCESSAMENTO");
  });
});

describe("os grupos que filtram as listas", () => {
  it("⚠️ 'ativas' EXCLUI arquivadas e canceladas — é o que faz arquivar significar algo", () => {
    /**
     * Sem isso, a análise arquivada continuaria na mesma lista, no mesmo lugar, e o cliente concluiria
     * que o botão "Arquivar" não faz nada.
     */
    const ativas = GRUPOS_DE_SITUACAO.ativas.status!;
    expect(ativas).not.toContain("ARQUIVADA");
    expect(ativas).not.toContain("CANCELADA");
    expect(ativas).toContain("ERRO_PROCESSAMENTO");
  });

  it("⚠️ todo status DO ENUM DO PRISMA aparece em algum grupo além de 'todas'", () => {
    /**
     * Status que não cabe em grupo nenhum vira análise INVISÍVEL: não aparece em nenhuma aba, e ninguém
     * descobre que existe. É como `EM_REVISAO` se comportaria se ficasse de fora.
     *
     * ⚠️ A lista vem do `AnalysisStatus` GERADO PELO PRISMA, e não de uma lista escrita aqui. A primeira
     * versão comparava dois literais digitados à mão — e portanto não protegia nada: quem acrescentasse
     * um status ao `schema.prisma` teria de editar as duas listas para o teste falhar, o que é justamente
     * o que ele deveria dispensar. Com o enum de verdade, o status novo faz este teste cair sozinho.
     */
    const cobertos = new Set(
      Object.entries(GRUPOS_DE_SITUACAO)
        .filter(([nome]) => nome !== "todas")
        .flatMap(([, g]) => g.status ?? []),
    );
    const doEnum = Object.values(AnalysisStatus);
    expect(doEnum.length).toBeGreaterThan(0);
    for (const s of doEnum) expect(cobertos.has(s)).toBe(true);
  });

  it("grupo desconhecido na URL cai no padrão, não em filtro vazio", () => {
    /**
     * `searchParams` é entrada de quem navega. Filtro vazio mostraria uma lista sem nada e pareceria
     * "não há análises" — pior que ignorar o parâmetro.
     */
    expect(grupoDaUrl("inventado")).toBe("ativas");
    expect(grupoDaUrl(undefined, "atencao")).toBe("atencao");
    expect(grupoDaUrl("arquivadas")).toBe("arquivadas");
  });

  it("⚠️ chave herdada de Object.prototype NÃO passa por grupo válido", () => {
    /**
     * O teste acima passava com o operador `in`, que percorre a cadeia de protótipos: `"constructor" in
     * GRUPOS_DE_SITUACAO` é verdadeiro. `?situacao=constructor` era aceito como grupo, o valor lido era a
     * função Object, `.rotulo` ficava indefinido e a tela chamava `.toLowerCase()` nele — 500 na tela de
     * trabalho do atendimento, por uma URL pública.
     */
    for (const chave of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(grupoDaUrl(chave)).toBe("ativas");
      expect(grupoDaUrl(chave, "atencao")).toBe("atencao");
    }
  });
});
