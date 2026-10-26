/**
 * Prova que uma CÓPIA RESTAURADA do banco serve para alguma coisa.
 *
 * ── Por que este script existe ────────────────────────────────────────────────
 * Backup que nunca foi restaurado não é backup — é uma esperança com nome de arquivo. E "a restauração
 * terminou sem erro" também não é prova: um `pg_restore` pode terminar com aviso e deixar tabela vazia,
 * constraint desligada, linha órfã ou uma versão do schema mais antiga que o código. Nos três casos a
 * cópia parece boa e não é.
 *
 * Pior: o momento em que se descobre isso é justamente o pior possível — quando o banco de produção já se
 * perdeu e esta cópia é a única coisa que resta.
 *
 * Este script responde uma pergunta só: **se eu tivesse que virar a chave para esta cópia agora, o
 * sistema funcionaria e o dado do cliente estaria legível?**
 *
 * ── Como usar ─────────────────────────────────────────────────────────────────
 *   1. No painel do Render, restaure o backup para um banco NOVO (Recovery → restore).
 *   2. Rode este script apontando para ele:
 *
 *        DATABASE_URL="<url-da-cópia>" npm run backup:verificar
 *
 *      Dentro do Render, isso é um One-Off Job com esse comando — o que mantém a `DATABASE_URL` de
 *      produção longe de máquina de desenvolvimento, como manda o CONTRIBUTING.md.
 *
 * ── É SEGURO rodar em produção ────────────────────────────────────────────────
 * Só há `SELECT` aqui. Nenhuma escrita, nenhum `DELETE`, nenhum DDL. Rodar contra o banco de verdade é
 * inofensivo e às vezes útil: as mesmas invariantes valem lá, e três delas já pegaram defeito real neste
 * projeto (ver os comentários de cada verificação).
 *
 * ── O que este script NÃO faz ────────────────────────────────────────────────
 * Não compara a cópia com a produção linha por linha: para isso seria preciso ler os dois bancos ao mesmo
 * tempo, e a `DATABASE_URL` de produção não deve conviver com nada. O que ele faz é verificar que a cópia
 * é internamente coerente, completa e legível — que é o que decide se ela é utilizável.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/db";
import { decryptField } from "../src/lib/crypto";

type Resultado = {
  ok: boolean;
  detalhe: string;
  /** Quando `true`, falhar aqui não condena a cópia — só merece olhada. */
  aviso?: boolean;
};

type Verificacao = {
  nome: string;
  /** Por que esta verificação existe. Aparece no relatório quando ela falha. */
  porque: string;
  executar: () => Promise<Resultado>;
};

/** Modelos que o schema declara. Uma restauração que perdeu tabela é pega aqui. */
const TABELAS_ESPERADAS = [
  "User", "Organization", "Session", "AuthToken", "Plan", "CreditPack", "Subscription", "Payment",
  "HotmartEvent", "Analysis", "Document", "DocumentPage", "TimelineEvent", "Report", "Petition",
  "LegalReview", "ConsumptionRecord", "CreditLedger", "AiUsageRecord", "KnowledgeDocument",
  "KnowledgeRevision", "PromptVersion", "SupportTicket", "SupportMessage", "Notification", "Consent",
  "SystemSetting", "ContentBlock", "AuditLog", "SecurityEvent", "AsaasCheckout",
] as const;

/**
 * Tabelas sem as quais a aplicação não FUNCIONA, mesmo que o banco esteja de pé.
 *
 * Restaurar um banco com zero planos deixa a página de vendas vazia e ninguém consegue assinar; sem
 * `PromptVersion` a análise não roda; sem `ContentBlock` a vitrine abre em branco. É a diferença entre
 * "o banco voltou" e "o produto voltou".
 */
const TABELAS_QUE_NAO_PODEM_ESTAR_VAZIAS = ["Plan", "PromptVersion", "ContentBlock"] as const;

const contar = async (tabela: string): Promise<number> => {
  const r = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${tabela}"`);
  return Number(r[0]?.n ?? 0);
};

/**
 * Classifica os documentos guardados em CINCO estados — função PURA, e é por isso que ela existe.
 *
 * ── Por que separada da consulta ──────────────────────────────────────────────
 * Esta lógica reportou errado DUAS vezes seguidas contra o banco de produção, em 02/09/2026: primeiro
 * culpou a chave por um dado que estava em claro, depois contradisse a própria contagem quando o caso era
 * "formato inesperado". Relatório de verificação que mente é pior que não ter relatório — gasta a
 * confiança de quem lê justamente quando ela é necessária.
 *
 * Conferir à mão não bastou, e testar pelo banco também não: o banco de teste tem documentos de outros
 * arquivos de teste e do seed, então a contagem nunca fecha e o teste vira uma disputa de isolamento.
 * Pura, ela é testável estado por estado, sem banco e sem interferência.
 *
 * ── A regra que faltava ──────────────────────────────────────────────────────
 * Cada estado medido precisa da SUA frase. Uma explicação que serve para dois estados vai acabar sendo
 * usada para o terceiro — foi exatamente o que aconteceu.
 *
 *  - EM CLARO  → dado intacto, só não passou pela cifragem. Falta cifrar; não há perda.
 *  - NÃO ABRE  → cifrado com OUTRA chave. Irrecuperável neste ambiente.
 *  - ABRE com formato estranho → a chave está CERTA (foi ela que abriu). É qualidade de dado, não
 *    problema de restauração — por isso é aviso, e não falha.
 */
export function classificarDocumentos(linhas: { id: string; documentEnc: string }[]): Resultado {
  if (linhas.length === 0) return { ok: true, detalhe: "nenhum documento cifrado nesta cópia", aviso: true };

  const emClaro: string[] = [];
  const naoAbrem: string[] = [];
  const formatoEstranho: string[] = [];

  for (const linha of linhas) {
    if (!linha.documentEnc.startsWith("v1.")) {
      emClaro.push(linha.id);
      continue;
    }
    let aberto: string | null = null;
    try {
      aberto = decryptField(linha.documentEnc);
    } catch {
      aberto = null;
    }
    if (aberto === null) {
      naoAbrem.push(linha.id);
      continue;
    }
    /**
     * Tira a pontuação antes de julgar: CPF gravado como `529.982.247-25` é dado perfeitamente legível,
     * e a versão anterior o acusava. CPF tem 11 dígitos, CNPJ tem 14.
     */
    const digitos = aberto.replace(/\D/g, "");
    if (digitos.length !== 11 && digitos.length !== 14) formatoEstranho.push(linha.id);
  }

  /** Nunca imprime o documento em si — só o id da linha, para quem for consertar achar. */
  const ids = (lista: string[]) => lista.slice(0, 5).join(", ");

  if (naoAbrem.length) {
    return {
      ok: false,
      detalhe:
        `de ${linhas.length}: ${naoAbrem.length} com o rótulo de cifrado que NÃO ABRE — ` +
        `linha(s): ${ids(naoAbrem)}. Foi cifrado com OUTRA chave: confira se a FIELD_ENCRYPTION_KEY é a ` +
        "mesma de quando o dado foi gravado. Se não for, este documento é irrecuperável e o titular " +
        "precisa reinformá-lo.",
    };
  }

  if (emClaro.length) {
    return {
      ok: false,
      detalhe:
        `de ${linhas.length}: ${emClaro.length} gravado(s) EM CLARO, sem cifragem — ` +
        `linha(s): ${ids(emClaro)}. O dado está INTACTO e legível; falta cifrar. Não há perda.`,
    };
  }

  if (formatoEstranho.length) {
    return {
      ok: true,
      aviso: true,
      detalhe:
        `${linhas.length} documento(s) abrem com a chave deste ambiente — ` +
        `${formatoEstranho.length} com formato fora do esperado (linha(s): ${ids(formatoEstranho)}). ` +
        "A chave está correta: foi ela que abriu. É qualidade de dado, não risco de restauração.",
    };
  }

  return { ok: true, detalhe: `${linhas.length} documento(s) legíveis` };
}

/**
 * Exportada para `tests/verificacao-de-restauracao.test.ts`.
 *
 * A checagem da cifragem já reportou errado DUAS vezes contra o banco de produção — primeiro culpando a
 * chave por um dado que estava em claro, depois contradizendo a própria contagem. Um relatório de
 * verificação que mente é pior que não ter relatório: ele consome a confiança de quem lê. Por isso as
 * verificações passaram a ser exportadas e cobertas por teste, em vez de conferidas à mão.
 */
export const VERIFICACOES: Verificacao[] = [
  {
    nome: "schema na mesma versão do código",
    porque:
      "Uma cópia com schema antigo aceita conexão e quebra na primeira consulta que usa coluna nova. " +
      "Comparo o número de migrações aplicadas com o número de migrações no repositório.",
    executar: async () => {
      const aplicadas = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
      `;
      const noRepositorio = readdirSync(join(process.cwd(), "prisma", "migrations"), {
        withFileTypes: true,
      }).filter((e) => e.isDirectory()).length;

      const n = Number(aplicadas[0]?.n ?? 0);
      if (n === noRepositorio) return { ok: true, detalhe: `${n} migrações, iguais ao repositório` };
      return {
        ok: false,
        detalhe:
          `a cópia tem ${n} migrações aplicadas e o repositório tem ${noRepositorio}. ` +
          (n < noRepositorio
            ? "A cópia é ANTERIOR ao código: rode `npx prisma migrate deploy` contra ela antes de usar."
            : "A cópia é POSTERIOR ao código: este checkout está atrasado, sincronize antes de concluir nada."),
      };
    },
  },
  {
    nome: "todas as tabelas presentes",
    porque: "Restauração parcial deixa tabela de fora e o sintoma aparece só quando alguém usa a tela dela.",
    executar: async () => {
      const presentes = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
      `;
      const nomes = new Set(presentes.map((t) => t.table_name));
      const faltando = TABELAS_ESPERADAS.filter((t) => !nomes.has(t));

      if (faltando.length === 0) return { ok: true, detalhe: `${TABELAS_ESPERADAS.length} tabelas` };
      return { ok: false, detalhe: `faltam ${faltando.length}: ${faltando.join(", ")}` };
    },
  },
  {
    nome: "o produto tem o que precisa para funcionar",
    porque:
      "Banco de pé com catálogo vazio é produto fora do ar: sem plano ninguém assina, sem prompt a " +
      "análise não roda, sem conteúdo a vitrine abre em branco.",
    executar: async () => {
      const partes: string[] = [];
      const vazias: string[] = [];
      for (const tabela of TABELAS_QUE_NAO_PODEM_ESTAR_VAZIAS) {
        const n = await contar(tabela);
        partes.push(`${tabela}=${n}`);
        if (n === 0) vazias.push(tabela);
      }
      if (vazias.length === 0) return { ok: true, detalhe: partes.join(" ") };
      return { ok: false, detalhe: `vazias: ${vazias.join(", ")} (${partes.join(" ")})` };
    },
  },
  {
    nome: "nenhuma linha órfã",
    porque:
      "É a marca de restauração feita com as constraints desligadas (`--disable-triggers`, `--data-only`). " +
      "O banco aceita, e depois a aplicação estoura ao seguir uma referência que não existe.",
    executar: async () => {
      const orfaos = await prisma.$queryRaw<{ relacao: string; n: bigint }[]>`
        SELECT 'DocumentPage sem Document' AS relacao, count(*)::bigint AS n
          FROM "DocumentPage" p LEFT JOIN "Document" d ON d.id = p."documentId" WHERE d.id IS NULL
        UNION ALL
        SELECT 'Document sem Organization', count(*)::bigint
          FROM "Document" x LEFT JOIN "Organization" o ON o.id = x."organizationId" WHERE o.id IS NULL
        UNION ALL
        SELECT 'Subscription sem Plan', count(*)::bigint
          FROM "Subscription" s LEFT JOIN "Plan" pl ON pl.id = s."planId" WHERE pl.id IS NULL
        UNION ALL
        SELECT 'Subscription sem Organization', count(*)::bigint
          FROM "Subscription" s LEFT JOIN "Organization" o ON o.id = s."organizationId" WHERE o.id IS NULL
        UNION ALL
        SELECT 'CreditLedger sem Subscription', count(*)::bigint
          FROM "CreditLedger" c LEFT JOIN "Subscription" s ON s.id = c."subscriptionId" WHERE s.id IS NULL
        UNION ALL
        SELECT 'Analysis sem Organization', count(*)::bigint
          FROM "Analysis" a LEFT JOIN "Organization" o ON o.id = a."organizationId" WHERE o.id IS NULL
      `;
      const ruins = orfaos.filter((o) => Number(o.n) > 0);
      if (ruins.length === 0) return { ok: true, detalhe: `${orfaos.length} relações conferidas` };
      return { ok: false, detalhe: ruins.map((r) => `${r.relacao}: ${Number(r.n)}`).join("; ") };
    },
  },
  {
    nome: "o livro de créditos fecha",
    porque:
      "Cada linha do extrato guarda saldo anterior, movimento e saldo posterior. A conta tem de fechar em " +
      "TODAS: é crédito que o cliente pagou. Linha que não fecha é dado corrompido, e aqui isso é dinheiro.",
    executar: async () => {
      const r = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM "CreditLedger"
        WHERE "balanceAfter" <> "balanceBefore" + "quantity"
      `;
      const n = Number(r[0]?.n ?? 0);
      const total = await contar("CreditLedger");
      if (n === 0) return { ok: true, detalhe: `${total} movimentos, todos fechando` };
      return { ok: false, detalhe: `${n} de ${total} movimentos com saldo inconsistente` };
    },
  },
  {
    nome: "todo pagamento do Asaas tem referência externa",
    porque:
      "A conferência de pagamento é feita por `externalId`, nunca por `subscriptionId` — a coluna de " +
      "assinatura vira NULL quando a assinatura é apagada. Pagamento do Asaas sem referência externa é " +
      "dinheiro que entrou e não dá para rastrear.",
    executar: async () => {
      const r = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM "Payment"
        WHERE provider = 'ASAAS' AND ("externalId" IS NULL OR "externalId" = '')
      `;
      const n = Number(r[0]?.n ?? 0);
      const total = await contar("Payment");
      if (n === 0) return { ok: true, detalhe: `${total} pagamentos, todos rastreáveis` };
      return { ok: false, detalhe: `${n} pagamento(s) do Asaas sem externalId` };
    },
  },
  {
    nome: "renovação automática só onde existe cobrança automática",
    porque:
      "`nextRenewalAt` preenchido significa 'esta assinatura se cobra sozinha'. Em venda MANUAL não há " +
      "quem execute a cobrança: a data promete ao cliente uma renovação que ninguém faz, e faz a " +
      "varredura diária deixar de encerrar o ciclo — inflando o faturamento declarado para sempre.",
    executar: async () => {
      const r = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM "Subscription"
        WHERE "nextRenewalAt" IS NOT NULL AND provider = 'MANUAL'
      `;
      const n = Number(r[0]?.n ?? 0);
      if (n === 0) return { ok: true, detalhe: "nenhuma venda manual prometendo renovação" };
      return { ok: false, detalhe: `${n} assinatura(s) MANUAL com nextRenewalAt preenchido` };
    },
  },
  {
    nome: "o CPF/CNPJ guardado ainda abre com a chave atual",
    porque:
      "ESTA é a verificação que separa 'restaurei o banco' de 'recuperei o sistema'. O documento é " +
      "cifrado com a FIELD_ENCRYPTION_KEY. Se a cópia é de antes de uma troca de chave, ou se a chave " +
      "deste ambiente não é a mesma que cifrou, o dado está lá e ninguém consegue ler — e não há como " +
      "descobrir isso depois, só antes.",
    executar: async () => {
      const usuarios = await prisma.$queryRaw<{ id: string; documentEnc: string }[]>`
        SELECT id, "documentEnc" FROM "User"
        WHERE "documentEnc" IS NOT NULL AND "documentEnc" <> ''
        LIMIT 500
      `;
      if (usuarios.length === 0) return { ok: true, detalhe: "nenhum documento cifrado nesta cópia", aviso: true };

      return classificarDocumentos(usuarios);
    },
  },
  {
    nome: "a tranca de linha está instalada",
    porque:
      "A migração que liga a tranca (RLS) captura erro de permissão e vira AVISO, para não derrubar o " +
      "site no boot. O preço desse cuidado é poder passar em silêncio — e uma tranca que não foi " +
      "instalada é indistinguível de uma instalada, se ninguém olhar. Esta verificação olha.",
    executar: async () => {
      const esperadas = ["Analysis", "Document", "DocumentPage", "LegalReview", "Petition", "Report", "TimelineEvent"];
      const ligadas = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND rowsecurity
      `;
      const nomes = new Set(ligadas.map((t) => t.tablename));
      const faltando = esperadas.filter((t) => !nomes.has(t));

      /**
       * Informação, não defeito: hoje a aplicação conecta como DONA das tabelas, e o Postgres ignora a
       * política para o dono. Dizer isto no relatório evita que alguém leia "instalada" como "protegendo".
       */
      const atravessa = await prisma.$queryRaw<{ dona: boolean; superusuario: boolean }[]>`
        SELECT
          EXISTS (
            SELECT 1 FROM pg_tables
            WHERE schemaname = current_schema() AND tablename = 'DocumentPage' AND tableowner = current_user
          ) AS dona,
          COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS superusuario
      `;
      const passaPorCima = atravessa[0]?.dona || atravessa[0]?.superusuario;
      const nota = passaPorCima
        ? " — ⚠️ esta conexão é dona/superusuária e ATRAVESSA a tranca (é o estado de hoje em produção)"
        : " — e esta conexão está sujeita a ela";

      if (faltando.length === 0) {
        return { ok: true, detalhe: `${esperadas.length} tabelas de conteúdo${nota}` };
      }
      return { ok: false, detalhe: `sem tranca: ${faltando.join(", ")}${nota}` };
    },
  },
  {
    nome: "o texto dos processos está legível",
    porque:
      "É o conteúdo que sustenta a análise jurídica. Página gravada e ilegível é análise concluída sobre " +
      "nada — o defeito mais caro possível num produto que gera peça processual.",
    executar: async () => {
      const total = await contar("DocumentPage");
      if (total === 0) return { ok: true, detalhe: "nenhuma página nesta cópia", aviso: true };

      const amostra = await prisma.$queryRaw<{ id: string; text: string; legible: boolean }[]>`
        SELECT id, text, legible FROM "DocumentPage" WHERE legible = true LIMIT 200
      `;
      if (amostra.length === 0) {
        return { ok: true, detalhe: `${total} páginas, nenhuma marcada como legível`, aviso: true };
      }

      /**
       * Depois da etapa 3 o texto passa a ser cifrado em repouso, e `lerTextoDaPagina` decide sozinho o
       * formato. Enquanto isso, texto vazio numa página marcada como legível já é contradição suficiente
       * para acusar corrupção.
       */
      const vazias = amostra.filter((p) => !p.text || p.text.trim().length === 0).length;
      if (vazias === 0) return { ok: true, detalhe: `${amostra.length} de ${total} páginas conferidas` };
      return { ok: false, detalhe: `${vazias} de ${amostra.length} páginas legíveis estão VAZIAS` };
    },
  },
];

async function main(): Promise<void> {
  console.log("\nVERIFICAÇÃO DE RESTAURAÇÃO");
  console.log("Pergunta: se fosse preciso virar a chave para esta cópia agora, o sistema funcionaria?\n");

  const falhas: { nome: string; porque: string; detalhe: string }[] = [];
  const avisos: string[] = [];

  for (const v of VERIFICACOES) {
    let r: Resultado;
    try {
      r = await v.executar();
    } catch (e) {
      r = { ok: false, detalhe: `a verificação não pôde rodar: ${(e as Error).message}` };
    }

    const marca = r.ok ? (r.aviso ? "–" : "✓") : "✗";
    console.log(`  ${marca} ${v.nome.padEnd(48)} ${r.detalhe}`);
    if (!r.ok) falhas.push({ nome: v.nome, porque: v.porque, detalhe: r.detalhe });
    else if (r.aviso) avisos.push(`${v.nome}: ${r.detalhe}`);
  }

  if (falhas.length === 0) {
    console.log("\n✅ Esta cópia é utilizável.");
    if (avisos.length) {
      console.log("\nSem conteúdo para conferir (não é defeito, mas reduz o que foi provado):");
      for (const a of avisos) console.log(`   – ${a}`);
      console.log("   Uma cópia vazia passa em quase tudo. Confira as contagens acima antes de confiar.");
    }
    return;
  }

  console.log(`\n❌ ${falhas.length} problema(s). Esta cópia NÃO deve ser tratada como boa:\n`);
  for (const f of falhas) {
    console.log(`   ${f.nome}`);
    console.log(`   o que aconteceu: ${f.detalhe}`);
    console.log(`   por que importa:  ${f.porque}\n`);
  }
  process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("[restauracao] erro:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
