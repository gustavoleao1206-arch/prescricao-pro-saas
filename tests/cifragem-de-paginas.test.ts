import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  cifrarTextoDaPagina,
  lerTextoDaPagina,
  jaEstaCifrado,
  lerPaginasDoDocumento,
  PaginaIlegivelError,
  LIMITE_DE_CARACTERES,
} from "../src/lib/pagina-do-processo";

/**
 * Cifragem em repouso do texto dos processos (etapa 3).
 *
 * O conteúdo integral de execução fiscal é o dado mais sensível da Plataforma: autos de terceiro sob
 * sigilo profissional. Estes testes travam as três armadilhas descritas em `src/lib/pagina-do-processo.ts`,
 * e a mais importante não é a cifragem em si — é o MODO DE FALHA. Cifrar mal cria um defeito pior do que
 * não cifrar: chave errada devolvendo texto vazio faria a IA concluir pela inexistência de parcelamento
 * ou penhora sobre páginas que estão lá, e a peça sairia sob a marca da Leão Amorim.
 */

const prisma = new PrismaClient();

/** Prefixo próprio deste arquivo. Não pode começar com o prefixo de outro teste — ver CONTRIBUTING.md. */
const PREFIXO = "test-cifpagina";

const TEXTO_DE_PROCESSO =
  "EXECUCAO FISCAL 0001234-56.2019.8.05.0001. Certidao de Divida Ativa n. 99/2019. " +
  "Despacho: cite-se. Parcelamento deferido em 12/03/2020, art. 174, paragrafo unico, IV, do CTN.";

async function limpar(): Promise<void> {
  await prisma.documentPage.deleteMany({ where: { document: { filename: { startsWith: PREFIXO } } } });
  await prisma.document.deleteMany({ where: { filename: { startsWith: PREFIXO } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIXO } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIXO } } });
}

/** Cada caso cria o seu próprio documento; o contador evita colidir na chave única do e-mail. */
let sequencia = 0;

async function criarDocumento(): Promise<string> {
  const n = ++sequencia;
  const dono = await prisma.user.create({
    data: { email: `${PREFIXO}-dono-${n}@exemplo.local`, name: `${PREFIXO} Dono ${n}`, role: "CLIENTE", status: "ATIVO" },
  });
  const org = await prisma.organization.create({ data: { name: `${PREFIXO} Escritorio ${n}`, ownerId: dono.id } });
  const doc = await prisma.document.create({
    data: {
      organizationId: org.id,
      filename: `${PREFIXO}-processo-${n}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 100,
      storageKey: `${PREFIXO}/${n}.pdf`,
      status: "PROCESSADO",
    },
  });
  return doc.id;
}

beforeAll(limpar);
afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

describe("cifragem do texto da página", () => {
  it("o texto vai e volta inteiro", () => {
    const guardado = cifrarTextoDaPagina(TEXTO_DE_PROCESSO);

    expect(guardado).not.toContain("EXECUCAO");
    expect(guardado).not.toContain("Parcelamento");
    expect(guardado.startsWith("v1.")).toBe(true);
    expect(lerTextoDaPagina(guardado, { documentId: "d", pageNumber: 1 })).toBe(TEXTO_DE_PROCESSO);
  });

  it("⚠️ o corte acontece ANTES de cifrar — cortar depois destruiria a página", () => {
    /**
     * GCM não abre pacote truncado. Se o corte de 500 mil caracteres fosse aplicado ao valor cifrado, ele
     * partiria o pacote no meio e a página estaria perdida para sempre, sem erro em log nenhum. É o erro
     * mais fácil de cometer aqui e o mais difícil de perceber.
     */
    const enorme = "A".repeat(LIMITE_DE_CARACTERES + 50_000);
    const guardado = cifrarTextoDaPagina(enorme);
    const aberto = lerTextoDaPagina(guardado, { documentId: "d", pageNumber: 1 });

    expect(aberto).toHaveLength(LIMITE_DE_CARACTERES);
    expect(aberto).toBe(enorme.slice(0, LIMITE_DE_CARACTERES));
  });

  it("cada gravação gera um valor diferente — mesmo texto, cifra distinta", () => {
    /** O IV é aleatório. Duas páginas idênticas não podem ser identificáveis como idênticas no banco. */
    const a = cifrarTextoDaPagina(TEXTO_DE_PROCESSO);
    const b = cifrarTextoDaPagina(TEXTO_DE_PROCESSO);

    expect(a).not.toBe(b);
    expect(lerTextoDaPagina(a, { documentId: "d", pageNumber: 1 })).toBe(
      lerTextoDaPagina(b, { documentId: "d", pageNumber: 2 }),
    );
  });

  it("página em branco continua em branco, e não é confundida com falha", () => {
    /**
     * `encryptField("")` não faz ida e volta: a última parte do formato fica vazia e a decifragem devolve
     * nulo. Página em branco é rotina em processo digitalizado, então vazio é gravado como vazio — e assim
     * "em branco" e "chave errada" seguem distinguíveis.
     */
    for (const vazio of ["", null, undefined]) {
      const guardado = cifrarTextoDaPagina(vazio);
      expect(guardado).toBe("");
      expect(jaEstaCifrado(guardado)).toBe(false);
      expect(lerTextoDaPagina(guardado, { documentId: "d", pageNumber: 1 })).toBe("");
    }
  });
});

describe("⚠️ o modo de falha: chave errada NÃO pode virar texto vazio", () => {
  it("cifrado que não abre LANÇA, em vez de devolver vazio", () => {
    /**
     * ESTE é o teste central da etapa 3. Se a leitura traduzisse falha em texto vazio, uma chave errada em
     * produção se disfarçaria de "PDF ruim do cliente": o checklist marcaria todo documento como ausente,
     * a detecção de atos não acharia nada, e a IA concluiria pela INEXISTÊNCIA de parcelamento sobre
     * páginas que existem. Não é tela vazia — é parecer jurídico errado.
     */
    const guardado = cifrarTextoDaPagina(TEXTO_DE_PROCESSO);
    /** Estraga o pacote mantendo o rótulo: é o que uma chave trocada produz na prática. */
    const corrompido = guardado.slice(0, -8) + "AAAAAAAA";

    expect(() => lerTextoDaPagina(corrompido, { documentId: "doc-1", pageNumber: 7 })).toThrow(PaginaIlegivelError);
    expect(() => lerTextoDaPagina(corrompido, { documentId: "doc-1", pageNumber: 7 })).toThrow(/página 7/);
  });

  it("o erro diz o que aconteceu e onde, para o suporte não adivinhar", () => {
    const corrompido = "v1.YWJj.YWJj.YWJj";
    try {
      lerTextoDaPagina(corrompido, { documentId: "doc-42", pageNumber: 3 });
      expect.unreachable("deveria ter lançado");
    } catch (e) {
      expect(e).toBeInstanceOf(PaginaIlegivelError);
      const erro = e as PaginaIlegivelError;
      expect(erro.documentId).toBe("doc-42");
      expect(erro.pageNumber).toBe(3);
      expect(erro.message).toMatch(/FIELD_ENCRYPTION_KEY/);
      /** A mensagem não pode conter o conteúdo da página: ela vai para log e auditoria. */
      expect(erro.message).not.toContain(corrompido);
    }
  });
});

describe("migração gradual: os dois formatos convivem", () => {
  it("texto legado em claro é lido como está", () => {
    /**
     * O acervo já gravado está em claro. Sem esta tolerância, ligar a cifragem tornaria ilegível toda
     * análise anterior à mudança — e uma conversão interrompida no meio deixaria a base inutilizável.
     */
    expect(lerTextoDaPagina(TEXTO_DE_PROCESSO, { documentId: "d", pageNumber: 1 })).toBe(TEXTO_DE_PROCESSO);
    expect(jaEstaCifrado(TEXTO_DE_PROCESSO)).toBe(false);
  });

  it("jaEstaCifrado distingue os dois formatos", () => {
    expect(jaEstaCifrado(cifrarTextoDaPagina("qualquer coisa"))).toBe(true);
    expect(jaEstaCifrado("texto em claro")).toBe(false);
    expect(jaEstaCifrado("")).toBe(false);
    expect(jaEstaCifrado(null)).toBe(false);
  });

  it("⚠️ a base MISTURADA é lida corretamente, página por página", async () => {
    const documentId = await criarDocumento();
    await prisma.documentPage.createMany({
      data: [
        { documentId, pageNumber: 1, text: cifrarTextoDaPagina("Pagina 1 cifrada"), legible: true },
        { documentId, pageNumber: 2, text: "Pagina 2 legada em claro", legible: true },
        { documentId, pageNumber: 3, text: "", legible: false },
        { documentId, pageNumber: 4, text: cifrarTextoDaPagina("Pagina 4 cifrada"), legible: true },
      ],
    });

    const paginas = await lerPaginasDoDocumento(documentId);

    expect(paginas.map((p) => p.page)).toEqual([1, 2, 3, 4]);
    expect(paginas.map((p) => p.text)).toEqual([
      "Pagina 1 cifrada",
      "Pagina 2 legada em claro",
      "",
      "Pagina 4 cifrada",
    ]);
  });

  it("no banco, o texto cifrado NÃO aparece em claro", async () => {
    const documentId = await criarDocumento();
    await prisma.documentPage.create({
      data: { documentId, pageNumber: 1, text: cifrarTextoDaPagina(TEXTO_DE_PROCESSO), legible: true },
    });

    /** Lê a coluna crua, sem passar pela decifragem — é o que veria quem obtivesse uma cópia do banco. */
    const cru = await prisma.$queryRaw<{ text: string }[]>`
      SELECT p.text FROM "DocumentPage" p
      JOIN "Document" d ON d.id = p."documentId"
      WHERE d.id = ${documentId}
    `;

    expect(cru).toHaveLength(1);
    expect(cru[0]!.text).not.toContain("EXECUCAO");
    expect(cru[0]!.text).not.toContain("Divida Ativa");
    expect(cru[0]!.text).not.toContain("Parcelamento");
    expect(cru[0]!.text.startsWith("v1.")).toBe(true);
  });

  it("a leitura em lotes traz todas as páginas, além do tamanho do lote", async () => {
    /** O lote é de 200: com 250 páginas, um erro de paginação apareceria como página faltando. */
    const documentId = await criarDocumento();
    await prisma.documentPage.createMany({
      data: Array.from({ length: 250 }, (_, i) => ({
        documentId,
        pageNumber: i + 1,
        text: cifrarTextoDaPagina(`Pagina ${i + 1}`),
        legible: true,
      })),
    });

    const paginas = await lerPaginasDoDocumento(documentId);

    expect(paginas).toHaveLength(250);
    expect(paginas[0]!.text).toBe("Pagina 1");
    expect(paginas[199]!.text).toBe("Pagina 200");
    expect(paginas[249]!.text).toBe("Pagina 250");
    /** Nenhuma repetida: erro de cursor duplicaria páginas em vez de perder. */
    expect(new Set(paginas.map((p) => p.page)).size).toBe(250);
  });

  it("⚠️ uma página ilegível interrompe a leitura do documento inteiro", async () => {
    /**
     * De propósito: seguir com 99 de 100 páginas produziria análise sobre processo incompleto sem ninguém
     * saber. A cobrança do crédito acontece depois da extração, então falhar aqui não custa crédito ao
     * cliente — a análise é marcada com erro e pode ser repetida.
     */
    const documentId = await criarDocumento();
    const bom = cifrarTextoDaPagina("Pagina boa");
    await prisma.documentPage.createMany({
      data: [
        { documentId, pageNumber: 1, text: bom, legible: true },
        { documentId, pageNumber: 2, text: bom.slice(0, -8) + "AAAAAAAA", legible: true },
      ],
    });

    await expect(lerPaginasDoDocumento(documentId)).rejects.toThrow(PaginaIlegivelError);
  });
});

describe("as duas escritas do sistema usam a função única", () => {
  it("⚠️ nenhum ponto grava página com slice cru — o defeito nasceu de duas linhas iguais em dois arquivos", async () => {
    /**
     * Travar a função não basta: o defeito volta se alguém escrever `text: p.text.slice(0, 500_000)` de
     * novo. Eram DOIS pontos com a mesma linha, e corrigir só um deixaria metade da base em claro — sem
     * sintoma, porque a leitura aceita os dois formatos.
     */
    const { readFileSync } = await import("node:fs");
    const semComentarios = (f: string) =>
      f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const arquivo of ["src/lib/analysis-runner.ts", "src/lib/document-intake.ts"]) {
      const fonte = semComentarios(readFileSync(arquivo, "utf8"));
      expect(fonte, arquivo).toContain("cifrarTextoDaPagina");
      expect(fonte, arquivo).not.toMatch(/text:\s*p\.text\.slice/);
      expect(fonte, arquivo).not.toMatch(/slice\(0,\s*500_000\)/);
    }
  });

  it("⚠️ a leitura do processo não carrega todas as páginas de uma vez", async () => {
    /**
     * `include: { pages: true }` alocaria o processo inteiro duas vezes — cifrado e decifrado — numa
     * instância de 512 MB que atende todos os clientes. E uma queda ali trava a fila de webhooks do Asaas:
     * cliente que pagou e fica sem acesso.
     */
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync("src/lib/analysis-runner.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(fonte).not.toMatch(/include:\s*\{\s*pages:\s*true\s*\}/);
    expect(fonte).toContain("lerPaginasDoDocumento");
  });
});
