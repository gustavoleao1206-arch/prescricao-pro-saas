import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/db";
import { logAudit, logLeitura } from "../src/lib/audit";
import { can } from "../src/lib/rbac";

/**
 * Trilha de LEITURA: quem, dentro da empresa, abriu o processo de qual cliente.
 *
 * ── O que estava aberto (frente D da auditoria de 17/08/2026) ─────────────────
 * ADMIN e REVISOR leem a análise de QUALQUER assinante — os autos de execução fiscal, sob sigilo
 * profissional — e nada ficava gravado. Três caminhos, nenhum registrado: o GET que devolve o conteúdo
 * integral em JSON, a tela que renderiza relatório e minuta, e o chamado de suporte, onde o cliente cola
 * número de processo e nome de parte para explicar o problema.
 *
 * A LGPD (art. 6, X, e art. 37) cobra poder DEMONSTRAR as operações de tratamento. "Quem leu a análise do
 * cliente X" era uma pergunta cuja resposta honesta seria "não sei".
 *
 * ── O prefixo dos dados ───────────────────────────────────────────────────────
 * `test-trilha-` não começa com o prefixo de nenhum outro arquivo (a limpeza usa `startsWith`, e um prefixo
 * que contém o de outro apaga os dados do outro no meio da execução).
 */

const PREFIXO = "test-trilha-";
const email = (n: string) => `${PREFIXO}${n}@exemplo.local`;

async function limpar() {
  const usuarios = await prisma.user.findMany({
    where: { email: { startsWith: PREFIXO } },
    select: { id: true },
  });
  const ids = usuarios.map((u) => u.id);
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.analysis.deleteMany({ where: { ownerId: { in: ids } } });
  }
  await prisma.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIXO } } });
  await prisma.securityEvent.deleteMany({ where: { type: "auditoria_nao_registrada", email: { startsWith: PREFIXO } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIXO } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIXO } } });
}

let leitorId = "";
let outroLeitorId = "";

beforeAll(async () => {
  await limpar();
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}escritorio` } });
  const leitor = await prisma.user.create({
    data: { email: email("revisor"), name: "Revisor de teste", passwordHash: "x", role: "REVISOR", organizationId: org.id },
  });
  const outro = await prisma.user.create({
    data: { email: email("admin"), name: "Admin de teste", passwordHash: "x", role: "ADMIN", organizationId: org.id },
  });
  leitorId = leitor.id;
  outroLeitorId = outro.id;
});

afterAll(limpar);

/** Conta os registros de uma leitura específica — nunca `findFirst` na tabela inteira. */
const contar = (actorId: string, entityId: string, action = "analysis.view") =>
  prisma.auditLog.count({ where: { actorId, action, entityType: "Analysis", entityId } });

describe("⚠️ registro de leitura, com folga para não afogar a trilha", () => {
  it("a primeira leitura fica gravada", async () => {
    const analiseId = `${PREFIXO}a1`;
    const gravou = await logLeitura({
      actorId: leitorId,
      actorRole: "REVISOR",
      action: "analysis.view",
      entityType: "Analysis",
      entityId: analiseId,
    });

    expect(gravou).toBe(true);
    expect(await contar(leitorId, analiseId)).toBe(1);
  });

  it("⚠️ a segunda leitura do MESMO leitor no MESMO item é suprimida", async () => {
    /**
     * Sem isto, a tela de análise — que chama `router.refresh()` a cada 4 segundos enquanto o processamento
     * corre — gravaria ~150 linhas idênticas por leitor numa análise de 10 minutos. Trilha que ninguém
     * consegue ler não serve de prova, e ainda enche o banco do plano mais barato do Render.
     */
    const analiseId = `${PREFIXO}a2`;
    const primeira = await logLeitura({
      actorId: leitorId, actorRole: "REVISOR", action: "analysis.view", entityType: "Analysis", entityId: analiseId,
    });
    const segunda = await logLeitura({
      actorId: leitorId, actorRole: "REVISOR", action: "analysis.view", entityType: "Analysis", entityId: analiseId,
    });

    expect(primeira).toBe(true);
    expect(segunda).toBe(false);
    expect(await contar(leitorId, analiseId)).toBe(1);
  });

  it("⚠️ a folga é por LEITOR: outra pessoa lendo o mesmo item grava", async () => {
    /**
     * É o caso que interessa numa apuração — dois funcionários abriram o mesmo processo. Se a folga fosse só
     * pelo item, o segundo leitor ficaria invisível, e a trilha diria que só um acessou.
     */
    const analiseId = `${PREFIXO}a3`;
    await logLeitura({ actorId: leitorId, actorRole: "REVISOR", action: "analysis.view", entityType: "Analysis", entityId: analiseId });
    const outro = await logLeitura({
      actorId: outroLeitorId, actorRole: "ADMIN", action: "analysis.view", entityType: "Analysis", entityId: analiseId,
    });

    expect(outro).toBe(true);
    expect(await contar(leitorId, analiseId)).toBe(1);
    expect(await contar(outroLeitorId, analiseId)).toBe(1);
  });

  it("⚠️ a folga é por ITEM: o mesmo leitor abrindo outro processo grava", async () => {
    /** Se a folga fosse só pelo leitor, abrir a análise do cliente A esconderia a leitura da do cliente B. */
    const a = `${PREFIXO}a4`;
    const b = `${PREFIXO}a5`;
    await logLeitura({ actorId: leitorId, actorRole: "REVISOR", action: "analysis.view", entityType: "Analysis", entityId: a });
    const outroItem = await logLeitura({
      actorId: leitorId, actorRole: "REVISOR", action: "analysis.view", entityType: "Analysis", entityId: b,
    });

    expect(outroItem).toBe(true);
    expect(await contar(leitorId, b)).toBe(1);
  });

  it("a folga é por AÇÃO: ver a tela e baixar o conteúdo são fatos diferentes", async () => {
    const analiseId = `${PREFIXO}a6`;
    await logLeitura({ actorId: leitorId, actorRole: "REVISOR", action: "analysis.view", entityType: "Analysis", entityId: analiseId });
    const leituraDoConteudo = await logLeitura({
      actorId: leitorId, actorRole: "REVISOR", action: "analysis.read", entityType: "Analysis", entityId: analiseId,
    });

    expect(leituraDoConteudo).toBe(true);
    expect(await contar(leitorId, analiseId, "analysis.read")).toBe(1);
  });

  it("passada a folga, a leitura volta a ser gravada", async () => {
    const analiseId = `${PREFIXO}a7`;
    await logLeitura({ actorId: leitorId, actorRole: "REVISOR", action: "analysis.view", entityType: "Analysis", entityId: analiseId });

    /** Envelhece o registro para além dos 15 minutos, em vez de esperar. */
    await prisma.auditLog.updateMany({
      where: { actorId: leitorId, entityId: analiseId, action: "analysis.view" },
      data: { createdAt: new Date(Date.now() - 20 * 60_000) },
    });

    const depois = await logLeitura({
      actorId: leitorId, actorRole: "REVISOR", action: "analysis.view", entityType: "Analysis", entityId: analiseId,
    });

    expect(depois).toBe(true);
    expect(await contar(leitorId, analiseId)).toBe(2);
  });
});

describe("⚠️ falha ao gravar a auditoria deixa de ser invisível", () => {
  it("registra evento de segurança quando o INSERT da trilha falha", async () => {
    /**
     * A trilha é o ÚNICO controle que o produto oferece em troca do acesso técnico irrestrito de ADMIN e
     * REVISOR. Um controle que pode falhar em silêncio não serve de prova: numa apuração, a ausência de linha
     * é ambígua entre "ninguém acessou" e "acessou e o registro caiu" — e a ambiguidade pesa contra quem tinha
     * o dever de registrar.
     *
     * A falha é forçada com um `actorId` que não existe: a chave estrangeira recusa o INSERT, que é o mesmo
     * efeito de banco indisponível ou conexões esgotadas.
     */
    const antes = await prisma.securityEvent.count({ where: { type: "auditoria_nao_registrada" } });

    await logAudit({
      actorId: "id-que-nao-existe-no-banco",
      action: "analysis.read",
      entityType: "Analysis",
      entityId: `${PREFIXO}inexistente`,
    });

    const depois = await prisma.securityEvent.count({ where: { type: "auditoria_nao_registrada" } });
    expect(depois).toBe(antes + 1);

    /** O evento tem de dizer O QUE não foi registrado, senão não serve para reconstituir a lacuna. */
    const evento = await prisma.securityEvent.findFirst({
      where: { type: "auditoria_nao_registrada" },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(evento?.metadata)).toContain(`${PREFIXO}inexistente`);
  });

  it("e o fluxo principal NÃO quebra — a decisão original está mantida", async () => {
    /** Derrubar o download de um documento porque a auditoria não gravou seria pior do que a lacuna. */
    await expect(
      logAudit({ actorId: "id-que-nao-existe-no-banco", action: "report.download" }),
    ).resolves.toBeUndefined();
  });
});

describe("⚠️ uma fonte só para a regra de quem lê o quê", () => {
  it("a matriz de permissões diz a VERDADE sobre o revisor", () => {
    /**
     * A matriz declarava para o REVISOR apenas `analysis:read:own`, e o código dava leitura irrestrita. Quem
     * auditasse — a ANPD, um cliente corporativo, o advogado da parte contrária — leria a matriz e concluiria
     * errado. Documento que afirma o oposto do que o sistema faz é pior do que documento nenhum.
     */
    expect(can("REVISOR", "analysis:read:all")).toBe(true);
    expect(can("ADMIN", "analysis:read:all")).toBe(true);
    expect(can("CLIENTE", "analysis:read:all")).toBe(false);
    expect(can("SUPORTE", "analysis:read:all")).toBe(false);
  });

  it("⚠️ e o isolamento CONSULTA a matriz, em vez de comparar papéis à mão", () => {
    /**
     * Antes havia duas fontes divergentes, e a matriz era a que ninguém executava — `can()` não tinha um
     * único chamador. Código que ninguém executa não é controle. Agora restringir o revisor é apagar uma linha
     * da matriz, e é isso que torna a decisão do dono viável sem reescrever regra espalhada.
     */
    const fonte = readFileSync("src/lib/tenant.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(fonte).toContain('can(ctx.user.role, "analysis:read:all")');
    expect(fonte).not.toMatch(/role === "REVISOR"/);
  });
});

describe("⚠️ os pontos de leitura registram, e a guarda não depende da pasta", () => {
  const semComentarios = (f: string) =>
    readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /**
   * ⚠️ Exige a CHAMADA, não a palavra.
   *
   * A primeira versão procurava `logLeitura` na fonte — e passou verde quando a chamada foi trocada por
   * `Promise.resolve(...)` de propósito, porque a palavra continuava na linha do `import`. Teste que passa
   * nos dois estados não prova nada.
   */
  const chamaLeitura = (fonte: string) => /await logLeitura\(\{/.test(fonte);

  it("o GET que devolve os autos inteiros registra a leitura", () => {
    const fonte = semComentarios("src/app/api/analises/[id]/route.ts");
    expect(chamaLeitura(fonte)).toBe(true);
    expect(fonte).toContain('action: "analysis.read"');
  });

  it("a tela por onde a leitura interna acontece registra", () => {
    const fonte = semComentarios("src/app/(app)/analises/[id]/page.tsx");
    expect(chamaLeitura(fonte)).toBe(true);
    expect(fonte).toContain('action: "analysis.view"');
  });

  it("o chamado de suporte registra a leitura DA EQUIPE, e o registro mora na função", () => {
    /** Nas telas seria registro em dois lugares e o terceiro nasceria sem ele. */
    const fonte = semComentarios("src/lib/support.ts");
    expect(chamaLeitura(fonte)).toBe(true);
    expect(fonte).toContain('action: "support.ticket_read"');
    expect(fonte).toContain("if (ehEquipe(usuario.role))");
  });

  it("⚠️ a página administrativa tem guarda PRÓPRIA, não só a do layout", () => {
    /**
     * A proteção da área toda repousava num único redirecionamento no layout. Funciona enquanto ninguém criar
     * página administrativa fora da pasta — e no dia em que criar, ela nasce sem portão.
     */
    const fonte = semComentarios("src/app/(admin)/admin/analises/page.tsx");
    expect(fonte).toContain('requireRole("ADMIN")');
  });

  it("a busca por cliente é registrada, porque antecede toda leitura indevida", () => {
    const fonte = semComentarios("src/app/(admin)/admin/analises/page.tsx");
    expect(fonte).toContain('action: "admin.analysis.search"');
    expect(fonte).toContain("termoBuscado");
  });

  it("a tela de auditoria mostra O ITEM acessado e permite filtrar por ele", () => {
    /** Antes respondia "houve um report.download" e não respondia "de qual cliente". */
    const fonte = semComentarios("src/app/(admin)/admin/logs/page.tsx");
    expect(fonte).toContain("entityId");
    expect(fonte).toContain("filtroAudit");
    expect(fonte).toContain("paginaComFiltro");
  });

  it("⚠️ a exportação do titular inclui os acessos, com PAPEL e sem identificar o funcionário", () => {
    /**
     * O cliente tem direito de saber que houve acesso interno e de que perfil. Nome, e-mail e IP de quem
     * acessou são dado pessoal de terceiro, num arquivo que o cliente baixa e redistribui.
     */
    const fonte = semComentarios("src/app/api/conta/exportar/route.ts");
    expect(fonte).toContain("acessos");
    expect(fonte).toContain("perfilDeQuemAcessou");
    /** Seleção explícita de campos: nunca devolver a linha inteira do registro. */
    expect(fonte).toContain("select: { createdAt: true");
    expect(fonte).not.toContain("userAgent");
    expect(fonte).not.toMatch(/actor:\s*\{\s*select/);
  });
});
