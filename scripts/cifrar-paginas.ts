/**
 * Converte o acervo de páginas já gravadas para o formato cifrado.
 *
 * ── O que é e o que não é ─────────────────────────────────────────────────────
 * NÃO é migração de estrutura: a coluna continua `TEXT NOT NULL`. É reescrita de DADO, linha por linha,
 * e por isso não passa pelo `prisma migrate` — passa por aqui, em lotes, podendo parar e continuar.
 *
 * ── Por que em lotes, e por que pode parar no meio ───────────────────────────
 * O acervo pode ter muitas páginas de 500 mil caracteres. Reescrever tudo numa transação prenderia o banco
 * e estouraria a memória da instância. Em lotes, cada lote é uma transação curta.
 *
 * Parar no meio é seguro: a leitura (`lerTextoDaPagina`) aceita os dois formatos ao mesmo tempo — valor
 * com o rótulo `v1.` é cifrado, qualquer outro é legado em claro. Uma execução interrompida deixa a base
 * misturada e o sistema funcionando; rodar de novo continua de onde parou, porque o filtro salta o que já
 * tem o rótulo.
 *
 * ── Seguro por padrão ────────────────────────────────────────────────────────
 * Sem `--aplicar`, NADA é escrito: o script conta o que faria e sai. Escrever exige pedir.
 *
 *   npm run paginas:cifrar                 # só conta (padrão)
 *   npm run paginas:cifrar -- --aplicar    # reescreve
 *   npm run paginas:cifrar -- --aplicar --lote 100
 *
 * ── ⚠️ ANTES DE RODAR COM --aplicar EM PRODUÇÃO ──────────────────────────────
 * Depois desta conversão, a `FIELD_ENCRYPTION_KEY` deixa de proteger só o CPF e passa a ser a única coisa
 * que abre o acervo de processos de TODOS os clientes. Perdê-la deixa de significar "CPF ilegível" e passa
 * a significar "nenhum processo de nenhum cliente é legível", sem volta.
 *
 * Portanto, nesta ordem: (1) a chave está guardada em lugar de onde se consegue recuperá-la, fora do
 * Render; (2) existe backup do banco cujo restauro foi verificado com `npm run backup:verificar`; (3) só
 * então rodar aqui. Backup do banco sem a chave é backup inútil.
 */

import { prisma } from "../src/lib/db";
import { cifrarTextoDaPagina, jaEstaCifrado, LIMITE_DE_CARACTERES } from "../src/lib/pagina-do-processo";

const argumentos = process.argv.slice(2);
const aplicar = argumentos.includes("--aplicar");
const tamanhoDoLote = (() => {
  const i = argumentos.indexOf("--lote");
  const n = i >= 0 ? Number(argumentos[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 1000 ? Math.floor(n) : 200;
})();

async function main(): Promise<void> {
  const total = await prisma.documentPage.count();
  console.log(`\nCIFRAGEM DO ACERVO DE PÁGINAS`);
  console.log(`Modo: ${aplicar ? "APLICAR (vai escrever)" : "somente contagem (nada será escrito)"}`);
  console.log(`Páginas na base: ${total}\n`);

  let vistas = 0;
  let convertidas = 0;
  let jaEstavam = 0;
  let vazias = 0;
  /**
   * O cursor anda por id, e não por deslocamento: reescrever linhas muda a ordem de um `skip`/`take` e
   * faria o script pular páginas sem perceber. Por id, cada linha é vista uma vez.
   */
  let cursor: string | undefined;

  for (;;) {
    const lote = await prisma.documentPage.findMany({
      select: { id: true, text: true },
      orderBy: { id: "asc" },
      take: tamanhoDoLote,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (lote.length === 0) break;
    cursor = lote[lote.length - 1]!.id;
    vistas += lote.length;

    const paraEscrever: { id: string; text: string }[] = [];
    for (const p of lote) {
      if (jaEstaCifrado(p.text)) {
        jaEstavam += 1;
        continue;
      }
      if (!p.text || p.text.length === 0) {
        /** Página em branco continua em branco: `encryptField("")` não faz ida e volta. */
        vazias += 1;
        continue;
      }
      if (p.text.length > LIMITE_DE_CARACTERES) {
        /**
         * Não deveria existir (a escrita já corta), mas se existir o corte acontece aqui — sobre o texto
         * EM CLARO, que é a única ordem que não destrói a página.
         */
        console.log(`  aviso: página ${p.id} tem ${p.text.length} caracteres e será cortada no limite`);
      }
      paraEscrever.push({ id: p.id, text: cifrarTextoDaPagina(p.text) });
    }

    if (aplicar && paraEscrever.length > 0) {
      /**
       * Transação curta por lote: se cair no meio, o que já foi convertido está convertido e o resto
       * continua legível como legado. Rodar de novo termina o serviço.
       */
      await prisma.$transaction(
        paraEscrever.map((p) => prisma.documentPage.update({ where: { id: p.id }, data: { text: p.text } })),
      );
    }
    convertidas += paraEscrever.length;

    if (vistas % (tamanhoDoLote * 5) === 0 || lote.length < tamanhoDoLote) {
      console.log(`  ${vistas}/${total} páginas vistas — ${convertidas} a converter, ${jaEstavam} já cifradas`);
    }
    if (lote.length < tamanhoDoLote) break;
  }

  console.log(`\nRESUMO`);
  console.log(`  vistas ............ ${vistas}`);
  console.log(`  ${aplicar ? "convertidas ......" : "a converter ......."} ${convertidas}`);
  console.log(`  já cifradas ....... ${jaEstavam}`);
  console.log(`  vazias (mantidas) . ${vazias}`);

  if (!aplicar && convertidas > 0) {
    console.log(`\nNada foi escrito. Para converter de verdade:  npm run paginas:cifrar -- --aplicar`);
    console.log(`Antes disso, confirme a custódia da FIELD_ENCRYPTION_KEY e um backup verificado.`);
  }
  if (aplicar) {
    const restantes = await prisma.documentPage.count({ where: { NOT: { text: { startsWith: "v1." } } } });
    /** Inclui as vazias, que continuam em claro de propósito. */
    console.log(`  ainda sem rótulo .. ${restantes} (as vazias entram nesta conta)`);
  }
}

main()
  .catch((e) => {
    console.error("[cifrar-paginas] erro:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
