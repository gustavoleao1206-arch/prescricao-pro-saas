import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recebe as violações de Content-Security-Policy e as registra no log.
 *
 * ── Por que isto existe ───────────────────────────────────────────────────────
 * A política entra em modo RELATÓRIO: o navegador não bloqueia nada, só avisa o que teria bloqueado. Sem
 * alguém para receber esse aviso, o modo relatório é cego — a informação morreria no console do navegador do
 * cliente, onde ninguém olha. É aqui que ela chega ao log do Render.
 *
 * Isso importa especialmente para as telas privadas (painel, admin, ativação do segundo fator): elas não
 * podem ser exercitadas sem conta, então é o uso real que vai dizer se alguma delas depende de algo que a
 * política recusaria. Um log limpo por alguns dias é o que autoriza virar o bloqueio.
 *
 * ── Por que é público, e como isso não vira problema ──────────────────────────
 * Público por necessidade: o navegador envia o relatório sem cookie e sem sessão. As consequências disso são
 * tratadas de frente:
 *
 *  - QUALQUER UM pode enviar conteúdo aqui. Por isso nada é gravado no banco — só log. Registro em banco
 *    seria uma tabela que um estranho enche até o disco acabar.
 *  - Limite por IP: 30 relatórios por minuto. Uma página com defeito real gera poucos relatórios repetidos;
 *    quem passar disso é abuso, e o excesso é DESCARTADO em silêncio (a especificação não espera resposta
 *    útil, então não há por que gastar processamento explicando).
 *  - Corpo limitado a 8 KB e o que se registra é recortado: o `blocked-uri` pode vir com URL longa, e log
 *    é memória e dinheiro.
 *
 * Responde 204 em tudo, inclusive no que recusa: o navegador não faz nada com a resposta, e devolver erro só
 * geraria ruído no console de quem está usando o sistema.
 */

const SEM_CONTEUDO = new Response(null, { status: 204 });

/** O que interessa de um relatório. O resto do corpo é ruído para o log. */
function resumir(bruto: unknown): string | null {
  if (!bruto || typeof bruto !== "object") return null;

  /**
   * Dois formatos, porque os navegadores divergem: `report-uri` manda
   * `{ "csp-report": {...} }`; `report-to` manda `[{ type, body: {...} }]`.
   */
  const corpo = (bruto as Record<string, unknown>)["csp-report"] ?? (bruto as Record<string, unknown>).body ?? bruto;
  if (!corpo || typeof corpo !== "object") return null;
  const c = corpo as Record<string, unknown>;

  const campo = (...nomes: string[]) => {
    for (const n of nomes) {
      const v = c[n];
      if (typeof v === "string" && v) return v.slice(0, 200);
    }
    return "?";
  };

  const diretiva = campo("effective-directive", "effectiveDirective", "violated-directive", "violatedDirective");
  const bloqueado = campo("blocked-uri", "blockedURL", "blockedURI");
  const pagina = campo("document-uri", "documentURL", "documentURI");
  const linha = campo("line-number", "lineNumber");
  const trecho = campo("script-sample", "sample");

  return `diretiva=${diretiva} bloqueado=${bloqueado} pagina=${pagina} linha=${linha} trecho=${trecho}`;
}

export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req);
  if (!rateLimit(`csp-relatorio:${ip}`, 30, 60).allowed) return SEM_CONTEUDO;

  const LIMITE = 8 * 1024;
  const declarado = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declarado) && declarado > LIMITE) return SEM_CONTEUDO;

  let texto: string;
  try {
    texto = await req.text();
  } catch {
    return SEM_CONTEUDO;
  }
  /** Confere o tamanho REAL também: o cabeçalho é declarado por quem envia. */
  if (texto.length > LIMITE) return SEM_CONTEUDO;

  let resumo: string | null = null;
  try {
    resumo = resumir(JSON.parse(texto));
  } catch {
    resumo = null;
  }
  if (!resumo) return SEM_CONTEUDO;

  /**
   * `console.warn` e não `logAudit`: isto não é ato de usuário nem evento de segurança da aplicação — é
   * diagnóstico de implantação, e vai para o log do Render, que é onde se procura por ele.
   */
  console.warn(`[csp] violação relatada: ${resumo}`);
  return SEM_CONTEUDO;
}
