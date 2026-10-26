import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { definirInquilino, definirPapelDeServico } from "../src/lib/inquilino";

/**
 * A tranca de linha do Postgres (RLS) sobre o conteúdo dos processos.
 *
 * ── Por que este arquivo usa DUAS conexões ────────────────────────────────────
 * O Postgres IGNORA política de RLS para o dono da tabela e para superusuário. A suíte conecta como
 * superusuário, então um teste de isolamento escrito da forma óbvia passaria com a tranca ligada E com
 * ela desligada — o tipo de teste que este projeto proíbe.
 *
 * Por isso `scripts/pg-teste.mjs` cria `ptp_app`, um usuário SEM superusuário e que não é dono das
 * tabelas, espelhando o `prescricao_app` que a produção vai usar. Os dados são montados pela conexão do
 * dono (que atravessa a tranca de propósito) e a verificação é feita pela conexão da aplicação.
 *
 * ── O que estes testes provam, e o que NÃO provam ─────────────────────────────
 * Provam que a política isola escritórios de verdade quando a aplicação conecta como usuário próprio.
 * NÃO provam nada sobre a produção de hoje, que ainda conecta como dona das tabelas — e há um teste
 * abaixo que mede justamente isso, para o registro não ficar otimista demais.
 */

const URL_DONO = process.env.DATABASE_URL!;
const URL_APLICACAO = URL_DONO.replace("//ptp:ptp@", "//ptp_app:ptp_app@");

/** Conexão do DONO: monta o cenário atravessando a tranca. */
const dono = new PrismaClient();
/** Conexão da APLICAÇÃO: é sobre esta que a política atua. */
const app = new PrismaClient({ datasources: { db: { url: URL_APLICACAO } } });

/** Prefixo próprio deste arquivo — não pode começar com o de outro teste. */
const PREFIXO = "test-tranca";

let orgA = "";
let orgB = "";
let docA = "";
let docB = "";
let analiseA = "";

async function limpar(): Promise<void> {
  await dono.documentPage.deleteMany({ where: { document: { filename: { startsWith: PREFIXO } } } });
  await dono.report.deleteMany({ where: { analysis: { title: { startsWith: PREFIXO } } } });
  await dono.document.deleteMany({ where: { filename: { startsWith: PREFIXO } } });
  await dono.analysis.deleteMany({ where: { title: { startsWith: PREFIXO } } });
  await dono.organization.deleteMany({ where: { name: { startsWith: PREFIXO } } });
  await dono.user.deleteMany({ where: { email: { startsWith: PREFIXO } } });
}

/** Monta um escritório com uma análise, um documento e duas páginas. */
async function montarEscritorio(sufixo: string) {
  const u = await dono.user.create({
    data: { email: `${PREFIXO}-${sufixo}@exemplo.local`, name: `${PREFIXO} ${sufixo}`, role: "CLIENTE", status: "ATIVO" },
  });
  const org = await dono.organization.create({ data: { name: `${PREFIXO} ${sufixo}`, ownerId: u.id } });
  const analise = await dono.analysis.create({
    data: { organizationId: org.id, ownerId: u.id, title: `${PREFIXO} analise ${sufixo}`, status: "CONCLUIDA" },
  });
  const doc = await dono.document.create({
    data: {
      organizationId: org.id,
      analysisId: analise.id,
      filename: `${PREFIXO}-${sufixo}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 10,
      storageKey: `${PREFIXO}/${sufixo}.pdf`,
      status: "PROCESSADO",
    },
  });
  await dono.documentPage.createMany({
    data: [
      { documentId: doc.id, pageNumber: 1, text: `pagina 1 de ${sufixo}`, legible: true },
      { documentId: doc.id, pageNumber: 2, text: `pagina 2 de ${sufixo}`, legible: true },
    ],
  });
  return { orgId: org.id, docId: doc.id, analiseId: analise.id };
}

beforeAll(async () => {
  await limpar();
  const a = await montarEscritorio("alfa");
  const b = await montarEscritorio("beta");
  orgA = a.orgId;
  orgB = b.orgId;
  docA = a.docId;
  docB = b.docId;
  analiseA = a.analiseId;
});

afterAll(async () => {
  await limpar();
  await dono.$disconnect();
  await app.$disconnect();
});

describe("⚠️ a conexão de teste é mesmo a de um usuário sem privilégio", () => {
  it("ptp_app não é superusuário nem dono das tabelas", async () => {
    /**
     * Se esta afirmação cair, TODOS os testes abaixo passam a não provar nada — e passariam em silêncio,
     * porque superusuário simplesmente enxerga tudo. É a primeira coisa a conferir.
     */
    const papel = await app.$queryRaw<{ super: boolean }[]>`
      SELECT rolsuper AS super FROM pg_roles WHERE rolname = current_user
    `;
    expect(papel[0]?.super).toBe(false);

    const dona = await app.$queryRaw<{ dona: boolean }[]>`
      SELECT (tableowner = current_user) AS dona FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'DocumentPage'
    `;
    expect(dona[0]?.dona).toBe(false);
  });

  it("a tranca está LIGADA nas tabelas de conteúdo do processo", async () => {
    const tabelas = await app.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND rowsecurity ORDER BY tablename
    `;
    const nomes = tabelas.map((t) => t.tablename);

    expect(nomes).toEqual(
      expect.arrayContaining(["Analysis", "Document", "DocumentPage", "LegalReview", "Petition", "Report", "TimelineEvent"]),
    );
  });
});

describe("⚠️ isolamento entre escritórios", () => {
  it("sem inquilino definido, a aplicação não enxerga NADA", async () => {
    /**
     * É o comportamento certo para errar: uma consulta que esqueça de informar o inquilino devolve vazio,
     * em vez de devolver os autos de todo mundo. Falha visível é melhor que vazamento silencioso.
     */
    const analises = await app.analysis.count({ where: { title: { startsWith: PREFIXO } } });
    const documentos = await app.document.count({ where: { filename: { startsWith: PREFIXO } } });
    const paginas = await app.documentPage.count({ where: { document: { filename: { startsWith: PREFIXO } } } });

    expect(analises).toBe(0);
    expect(documentos).toBe(0);
    expect(paginas).toBe(0);
  });

  it("com o inquilino ALFA, enxerga só o que é do ALFA", async () => {
    const visto = await app.$transaction(async (tx) => {
      await definirInquilino(tx, orgA);
      return {
        analises: await tx.analysis.findMany({ where: { title: { startsWith: PREFIXO } }, select: { organizationId: true } }),
        documentos: await tx.document.findMany({ where: { filename: { startsWith: PREFIXO } }, select: { organizationId: true } }),
      };
    });

    expect(visto.analises).toHaveLength(1);
    expect(visto.analises[0]!.organizationId).toBe(orgA);
    expect(visto.documentos).toHaveLength(1);
    expect(visto.documentos[0]!.organizationId).toBe(orgA);
  });

  it("⚠️ pedir o documento do OUTRO escritório pelo id devolve vazio", async () => {
    /**
     * É o ataque que a tranca fecha: mesmo com o id em mãos — vindo de uma URL, de um log, de um erro de
     * filtro numa rota nova — o banco recusa a linha. Hoje isso depende de a aplicação lembrar de filtrar.
     */
    const alheio = await app.$transaction(async (tx) => {
      await definirInquilino(tx, orgA);
      return tx.document.findUnique({ where: { id: docB } });
    });

    expect(alheio).toBeNull();
  });

  it("⚠️ as PÁGINAS do processo alheio também somem — e elas não têm coluna de dono", async () => {
    /**
     * `DocumentPage` não guarda organizationId: a política chega nela pelo documento. Este é o teste que
     * prova que a subconsulta funciona, e é a tabela que guarda o texto integral dos autos.
     */
    const paginas = await app.$transaction(async (tx) => {
      await definirInquilino(tx, orgA);
      return tx.documentPage.findMany({ where: { documentId: docB } });
    });

    expect(paginas).toHaveLength(0);
  });

  it("trocar o inquilino troca o que se enxerga, na mesma conexão", async () => {
    const comoAlfa = await app.$transaction(async (tx) => {
      await definirInquilino(tx, orgA);
      return tx.documentPage.count({ where: { documentId: docA } });
    });
    const comoBeta = await app.$transaction(async (tx) => {
      await definirInquilino(tx, orgB);
      return tx.documentPage.count({ where: { documentId: docB } });
    });
    const betaVendoAlfa = await app.$transaction(async (tx) => {
      await definirInquilino(tx, orgB);
      return tx.documentPage.count({ where: { documentId: docA } });
    });

    expect(comoAlfa).toBe(2);
    expect(comoBeta).toBe(2);
    expect(betaVendoAlfa).toBe(0);
  });

  it("⚠️ o inquilino NÃO vaza da transação anterior", async () => {
    /**
     * `SET LOCAL` vale só até o fim da transação. Se o valor sobrevivesse, com pool de conexões o próximo
     * cliente herdaria o inquilino do anterior — exatamente o vazamento que a tranca existe para impedir.
     */
    await app.$transaction(async (tx) => {
      await definirInquilino(tx, orgA);
      expect(await tx.document.count({ where: { filename: { startsWith: PREFIXO } } })).toBe(1);
    });

    /** Fora da transação, sem inquilino: tem de voltar a zero. */
    expect(await app.document.count({ where: { filename: { startsWith: PREFIXO } } })).toBe(0);
  });

  it("não dá para GRAVAR no escritório alheio (pelo caminho do Prisma)", async () => {
    await expect(
      app.$transaction(async (tx) => {
        await definirInquilino(tx, orgA);
        return tx.documentPage.create({
          data: { documentId: docB, pageNumber: 99, text: "invasao", legible: true },
        });
      }),
    ).rejects.toThrow();
  });

  it("⚠️ e a recusa vem da cláusula de ESCRITA, não de um efeito colateral da leitura", async () => {
    /**
     * O teste acima passava pelo motivo errado, e só descobri desligando a proteção de propósito.
     *
     * O `create` do Prisma emite `INSERT ... RETURNING`, e no Postgres o `RETURNING` é filtrado pela
     * cláusula de LEITURA (`USING`) da política. Ou seja: com `WITH CHECK (true)` — política que permite
     * gravar em qualquer escritório — o `create` continuava falhando, porque a linha recém-inserida não
     * podia ser lida de volta. O teste ficava verde com a trava de escrita ABERTA.
     *
     * Isso não é detalhe acadêmico: sem `WITH CHECK`, um defeito de aplicação poderia ESCREVER nos autos
     * de outro escritório — e ninguém veria, porque a leitura continuaria isolada. É o pior dos dois
     * mundos: dado alheio corrompido em silêncio.
     *
     * `$executeRaw` emite `INSERT` puro, sem `RETURNING`. Aqui só a cláusula de escrita pode recusar.
     */
    await expect(
      app.$transaction(async (tx) => {
        await definirInquilino(tx, orgA);
        return tx.$executeRaw`
          INSERT INTO "DocumentPage" (id, "documentId", "pageNumber", text, legible)
          VALUES (${`${PREFIXO}-invasao`}, ${docB}, 98, 'invasao', true)
        `;
      }),
    ).rejects.toThrow(/row-level security|violates/i);

    /** E a linha não existe: confirmado pela conexão do dono, que atravessa a tranca. */
    const plantada = await dono.documentPage.count({ where: { documentId: docB, pageNumber: 98 } });
    expect(plantada).toBe(0);
  });
});

describe("a porta de serviço, para os fluxos que não têm inquilino", () => {
  it("como serviço, enxerga os dois escritórios", async () => {
    /**
     * O webhook do Asaas DESCOBRE de quem é a cobrança consultando o banco — não há como saber o inquilino
     * antes de consultar. Sem esta porta, a consulta voltaria vazia, o cliente pagaria e não receberia
     * acesso, sem nada registrado como erro.
     */
    const documentos = await app.$transaction(async (tx) => {
      await definirPapelDeServico(tx);
      return tx.document.findMany({ where: { filename: { startsWith: PREFIXO } }, select: { organizationId: true } });
    });

    expect(documentos).toHaveLength(2);
    expect(new Set(documentos.map((d) => d.organizationId))).toEqual(new Set([orgA, orgB]));
  });

  it("o papel de serviço também não sobrevive à transação", async () => {
    await app.$transaction(async (tx) => {
      await definirPapelDeServico(tx);
      expect(await tx.document.count({ where: { filename: { startsWith: PREFIXO } } })).toBe(2);
    });

    expect(await app.document.count({ where: { filename: { startsWith: PREFIXO } } })).toBe(0);
  });
});

describe("⚠️ o que a produção de HOJE ainda não tem", () => {
  it("a conexão DONA das tabelas atravessa a tranca — e é assim que a produção conecta", async () => {
    /**
     * Registro honesto, não defeito. A migração usa ENABLE e não FORCE, então o dono das tabelas continua
     * enxergando tudo — foi decisão deliberada, para a migração não poder derrubar o site no boot.
     *
     * A consequência é que a tranca só passa a proteger quando a aplicação passar a conectar com o usuário
     * próprio, criado no painel do Render (ver prisma/rls/usuario-de-aplicacao.sql). Este teste existe para
     * que ninguém leia os testes acima e conclua que a produção já está protegida.
     */
    const semInquilino = await dono.document.count({ where: { filename: { startsWith: PREFIXO } } });

    expect(semInquilino).toBe(2);
  });
});
