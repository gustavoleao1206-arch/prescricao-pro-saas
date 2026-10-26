import { prisma } from "./db";
import { encryptField, decryptField } from "./crypto";

/**
 * O texto das páginas do processo, cifrado em repouso.
 *
 * ── Por que existe um módulo só para isto ─────────────────────────────────────
 * O conteúdo integral de execução fiscal é o dado mais sensível que a Plataforma guarda: são autos de
 * terceiro sob sigilo profissional. Até aqui ficava legível no banco — quem obtivesse uma cópia do banco
 * ou um dump lia os processos de todos os clientes. Cifrar em repouso é o que transforma "vazou o banco"
 * em "vazou um arquivo ilegível".
 *
 * O mecanismo é o MESMO que já protege CPF/CNPJ (`src/lib/crypto.ts`, AES-256-GCM com rótulo `v1.`).
 * Nenhum segundo formato: duas cifras sem rótulo que as distinga fariam a decisão de "qual chave abre qual
 * coluna" morar na cabeça de quem escreveu, em vez de no próprio dado.
 *
 * ── As três armadilhas que este módulo existe para fechar ─────────────────────
 *
 * **1. Falhar em silêncio é PIOR do que não cifrar.** `decryptField` devolve `null` quando não consegue
 * abrir. Se a leitura da página traduzisse isso para texto vazio, uma chave errada em produção se
 * disfarçaria de "PDF ruim do cliente": o checklist marcaria todo documento como ausente, a detecção de
 * atos não acharia nada, e a IA concluiria pela INEXISTÊNCIA de parcelamento ou penhora sobre páginas que
 * existem e estão lá. O resultado não é uma tela vazia — é um parecer jurídico errado, com peça gerada
 * sob a marca da Leão Amorim. Por isso `lerTextoDaPagina` LANÇA, e a análise inteira é marcada com erro.
 *
 * **2. Cortar depois de cifrar destrói a página.** O texto é limitado a 500 mil caracteres antes de ser
 * gravado. Se o corte fosse aplicado ao valor CIFRADO, ele partiria o pacote no meio, e GCM não abre
 * pacote truncado: a página estaria perdida para sempre, sem erro nenhum no log. A ordem certa é cortar e
 * depois cifrar — e ela mora aqui, numa função, justamente porque a operação acontecia em DOIS arquivos e
 * corrigir só um deixaria metade da base em claro.
 *
 * **3. Página vazia não é página ilegível.** `encryptField("")` não faz ida e volta: a última parte do
 * formato fica vazia e `decryptField` devolve `null`. Página em branco é rotina em processo digitalizado,
 * então vazio continua sendo gravado como vazio — e assim "em branco" e "chave errada" seguem sendo
 * coisas distinguíveis, que é o que a etapa 1 corrigiu no CPF e não pode ser desfeito aqui.
 *
 * ── Migração gradual ─────────────────────────────────────────────────────────
 * O acervo já gravado está em claro. A leitura aceita os dois formatos: valor que começa com `v1.` é
 * cifrado e TEM de abrir; qualquer outro é texto legado e volta como está. Isso permite converter o
 * acervo em lotes (`scripts/cifrar-paginas.ts`) sem indisponibilidade, e sobrevive a uma conversão
 * interrompida no meio.
 */

/** Teto de caracteres por página. Vale sobre o texto EM CLARO — ver armadilha 2. */
export const LIMITE_DE_CARACTERES = 500_000;

/** Rótulo que `crypto.ts` põe na frente de todo valor cifrado. É o que distingue cifrado de legado. */
const MARCA_CIFRADA = "v1.";

/**
 * Quantas páginas são lidas do banco por vez.
 *
 * A leitura anterior trazia TODAS as páginas de TODOS os documentos da análise numa consulta. Com o texto
 * cifrado isso passaria a alocar duas cópias do processo inteiro ao mesmo tempo — a cifrada, ~37% maior, e
 * a decifrada. A instância de produção tem 512 MB e atende todos os clientes ao mesmo tempo; e uma queda
 * ali trava a fila de webhooks do Asaas, ou seja, cliente que pagou e fica sem acesso.
 *
 * Em lotes, o pico passa a ser "o processo decifrado" (que é inerente, e já era assim) mais um lote
 * cifrado, em vez do processo inteiro duas vezes.
 */
const PAGINAS_POR_LOTE = 200;

/**
 * Página que não pôde ser lida. Interrompe a análise de propósito — ver armadilha 1.
 *
 * A cobrança do crédito acontece DEPOIS da extração, então falhar aqui não custa crédito ao cliente: a
 * análise é marcada com erro e ele pode tentar de novo depois de o problema de chave ser resolvido.
 */
export class PaginaIlegivelError extends Error {
  constructor(
    readonly documentId: string,
    readonly pageNumber: number,
  ) {
    super(
      `A página ${pageNumber} do documento ${documentId} está gravada cifrada e não pôde ser aberta. ` +
        "Isto quase sempre significa FIELD_ENCRYPTION_KEY diferente da que cifrou o dado. " +
        "A análise foi interrompida de propósito: seguir sem este texto produziria conclusão jurídica " +
        "sobre um processo que o sistema não conseguiu ler.",
    );
    this.name = "PaginaIlegivelError";
  }
}

/** Prepara o texto para ser gravado: corta e depois cifra. Vazio continua vazio. */
export function cifrarTextoDaPagina(texto: string | null | undefined): string {
  const cortado = (texto ?? "").slice(0, LIMITE_DE_CARACTERES);
  if (cortado.length === 0) return "";
  return encryptField(cortado);
}

/** Abre o texto gravado. Aceita legado em claro; LANÇA se o cifrado não abrir. */
export function lerTextoDaPagina(
  guardado: string | null | undefined,
  onde: { documentId: string; pageNumber: number },
): string {
  if (!guardado) return "";

  /**
   * Sem o rótulo, é texto legado gravado antes desta etapa. Volta como está.
   *
   * Um texto de processo em claro que começasse com `v1.` e tivesse quatro partes base64 separadas por
   * ponto cairia no caminho de baixo e faria a análise falhar em vez de devolver lixo — o que é o lado
   * certo para errar.
   */
  if (!guardado.startsWith(MARCA_CIFRADA)) return guardado;

  const aberto = decryptField(guardado);
  if (aberto === null) throw new PaginaIlegivelError(onde.documentId, onde.pageNumber);
  return aberto;
}

/** Já está cifrado? Usado pela conversão do acervo para ser idempotente. */
export function jaEstaCifrado(guardado: string | null | undefined): boolean {
  return Boolean(guardado && guardado.startsWith(MARCA_CIFRADA));
}

/** Lê as páginas de um documento em lotes, já decifradas e em ordem. */
export async function lerPaginasDoDocumento(
  documentId: string,
): Promise<{ page: number; text: string }[]> {
  const paginas: { page: number; text: string }[] = [];

  for (let pulados = 0; ; pulados += PAGINAS_POR_LOTE) {
    const lote = await prisma.documentPage.findMany({
      where: { documentId },
      select: { pageNumber: true, text: true },
      orderBy: { pageNumber: "asc" },
      take: PAGINAS_POR_LOTE,
      skip: pulados,
    });
    if (lote.length === 0) break;

    for (const p of lote) {
      paginas.push({ page: p.pageNumber, text: lerTextoDaPagina(p.text, { documentId, pageNumber: p.pageNumber }) });
    }
    if (lote.length < PAGINAS_POR_LOTE) break;
  }

  return paginas;
}
