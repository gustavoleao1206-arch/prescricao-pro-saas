import { NextRequest, NextResponse } from "next/server";
import { areaDoCaminho, nomeDoCabecalho, politicaDeSeguranca, ROTA_DO_RELATORIO, type ModoDaCsp } from "@/lib/csp";

/**
 * Duas responsabilidades, e as duas de borda:
 *
 * 1. CONTENT-SECURITY-POLICY com nonce por requisição. Tem de ser aqui: o `next.config.mjs` é avaliado UMA
 *    vez, no build, então um nonce escrito lá seria o mesmo para todos os clientes e para sempre — o
 *    atacante leria o valor no próprio HTML e o usaria. Ficaria a aparência da proteção sem a proteção.
 *
 * 2. Redirecionar para /login quando falta o cookie de sessão nas áreas privadas. A validação REAL da
 *    sessão (banco, expiração, revogação, papel e ASSINATURA) ocorre no servidor
 *    (getSessionUser/requireRole/gate). Aqui é só um atalho de UX barato — o middleware roda no edge e não
 *    acessa o banco.
 *
 * O destino é /login, não /: a página principal virou a vitrine comercial e não contém mais o formulário.
 * Mandar para / deixaria o cliente numa página de vendas em vez da tela de acesso.
 */
const COOKIE = "ptp_session";
const PROTECTED = ["/painel", "/nova-analise", "/analises", "/creditos", "/configuracoes", "/suporte", "/assinatura", "/admin"];

/**
 * Modo da política.
 *
 * ── Por que o padrão é RELATÓRIO, e não bloqueio ──────────────────────────────
 * Em modo relatório o navegador não bloqueia nada: apenas avisa o que TERIA bloqueado. Errar uma diretiva
 * de script em modo bloqueio deixa o site vivo e inerte — páginas aparecem, nada funciona, nenhum login,
 * nenhum pagamento — e chega a todos os clientes de uma vez, porque o deploy é automático.
 *
 * O bloqueio real é a decisão do dono, e custa UMA linha no `render.yaml` (`CSP_MODO: bloqueio`), que chega
 * em produção pelo push e volta atrás pelo mesmo caminho. Até lá, as violações reais aparecem no log do
 * Render, inclusive nas telas privadas que não dá para exercitar sem conta.
 *
 * Lido de `process.env` direto, e não do módulo de ambiente: este arquivo roda no edge, e importar o módulo
 * inteiro só para ler uma variável engordaria o pacote do middleware.
 */
function modoDaCsp(): ModoDaCsp {
  return process.env.CSP_MODO === "bloqueio" ? "bloqueio" : "relatorio";
}

/** Nonce novo por requisição, com o gerador do próprio ambiente (o edge não tem `node:crypto`). */
function gerarNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const nonce = gerarNonce();
  const modo = modoDaCsp();
  const politica = politicaDeSeguranca({
    nonce,
    area: areaDoCaminho(pathname),
    modo,
    /** Ver o comentário do parâmetro: o `eval` é do recarregamento a quente, que não existe em produção. */
    desenvolvimento: process.env.NODE_ENV !== "production",
  });
  const cabecalho = nomeDoCabecalho(modo);

  /**
   * A política vai também nos cabeçalhos da REQUISIÇÃO, e não é redundância: é assim que o Next descobre o
   * nonce e o aplica nos scripts próprios dele durante a renderização. Sem esta linha, a área privada
   * ficaria com política de nonce e scripts sem nonce — exatamente o site inerte que se quer evitar.
   */
  const cabecalhosDaRequisicao = new Headers(req.headers);
  cabecalhosDaRequisicao.set("x-nonce", nonce);
  cabecalhosDaRequisicao.set("Content-Security-Policy", politica);

  const aplicar = (resposta: NextResponse) => {
    resposta.headers.set(cabecalho, politica);
    /** `report-to` só funciona com este cabeçalho declarando para onde vai. */
    resposta.headers.set("Reporting-Endpoints", `csp="${ROTA_DO_RELATORIO}"`);
    return resposta;
  };

  const needsAuth = PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  /**
   * ⚠️ A checagem de cookie continua restrita à lista PROTECTED.
   *
   * O `matcher` foi alargado para que a política alcance TAMBÉM as páginas públicas — vitrine, login,
   * cadastro, planos —, que são as mais expostas e as que trazem cliente novo. Se a checagem de sessão
   * tivesse sido alargada junto, visitante não logado passaria a ser mandado para /login na home: funil de
   * vendas morto. Esta separação é o ponto delicado deste arquivo.
   */
  if (!needsAuth) {
    return aplicar(NextResponse.next({ request: { headers: cabecalhosDaRequisicao } }));
  }

  if (!req.cookies.has(COOKIE)) {
    /**
     * O `next` tem de levar a QUERY, não só o caminho.
     *
     * Com apenas o pathname, `/assinatura/contratar?plano=essencial-mensal` virava
     * `/assinatura/contratar` depois do login: o plano que o cliente escolheu desaparecia no meio do
     * caminho. E os parâmetros originais ficavam soltos na URL do login, sem servir para nada.
     */
    const destino = `${pathname}${req.nextUrl.search}`;
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", destino);
    return aplicar(NextResponse.redirect(url));
  }

  return aplicar(NextResponse.next({ request: { headers: cabecalhosDaRequisicao } }));
}

export const config = {
  /**
   * Roda em toda página HTML, e em nada mais.
   *
   * ── O que a exclusão evita ────────────────────────────────────────────────
   * `api` fica fora porque resposta de API não é documento e não executa script no navegador. `_next/static`
   * e `_next/image` ficam fora porque são os arquivos que a própria aplicação serve — rodar middleware neles
   * custaria tempo em cada pedaço de JavaScript e cada imagem, sem proteger nada. E os arquivos com extensão
   * conhecida (ícone, imagem, fonte, o `tema.js` se um dia existir) pelo mesmo motivo.
   *
   * Antes, o matcher listava só as áreas privadas: uma CSP escrita aqui não alcançaria a vitrine, o login
   * nem o cadastro — e a proteção ficaria desigual sem ninguém perceber, porque o painel funcionaria.
   */
  matcher: [
    "/((?!api|_next/static|_next/image|.*\\.(?:ico|png|jpg|jpeg|svg|gif|webp|woff|woff2|ttf|otf|js|css|txt|xml|webmanifest)$).*)",
  ],
};
