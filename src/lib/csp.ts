import { HASH_DO_SCRIPT_DO_TEMA } from "./tema-inicial";

/**
 * Content-Security-Policy: a rede que transforma uma falha de escape em nada.
 *
 * ── Por que existe ────────────────────────────────────────────────────────────
 * Hoje o navegador de quem usa o sistema aceita executar qualquer script que apareça na página, de qualquer
 * origem. Não há falha conhecida — a auditoria confirmou que todo texto de cliente e toda saída de IA são
 * renderizados como TEXTO, e o React escapa isso automaticamente. O que falta é a segunda barreira: se um
 * dia entrar HTML de terceiro numa tela, sem CSP o atacante lê o cookie de sessão do advogado logado e
 * alcança as análises e os dados dos processos dos clientes dele.
 *
 * ── Duas políticas, e o motivo é técnico, não preguiça ────────────────────────
 * As 10 páginas públicas (vitrine, FAQ, textos legais) são geradas ESTATICAMENTE, no build. As 30 páginas
 * da área privada são geradas a cada requisição. Isso muda o que a política pode exigir:
 *
 *  - Página gerada por requisição pode usar `nonce`: um valor novo a cada visita, que o Next aplica
 *    automaticamente nos scripts próprios dele. É a forma forte.
 *  - Página estática NÃO pode: o HTML dela foi escrito no build, quando requisição não existia, e os
 *    scripts de arranque do Next já estão lá sem nonce. Exigir nonce nelas deixaria a vitrine viva mas
 *    inerte — nenhum botão, nenhum formulário — para todo visitante.
 *
 * Então a área privada, que é onde moram dado de cliente e sessão de advogado, recebe a política forte; as
 * páginas públicas recebem a política que o formato delas permite. Fingir que as duas podem ser iguais
 * quebraria justamente o funil de vendas.
 */

export type AreaDaPagina = "privada" | "publica";

/** Modo do cabeçalho: relatar sem bloquear, ou bloquear. */
export type ModoDaCsp = "relatorio" | "bloqueio";

/** Caminho que recebe as violações. Público por necessidade: o navegador as envia sem sessão. */
export const ROTA_DO_RELATORIO = "/api/csp-relatorio";

export function nomeDoCabecalho(modo: ModoDaCsp): string {
  return modo === "bloqueio" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}

/**
 * Monta a política. Função pura, para o teste conferir cada diretiva sem subir servidor.
 */
export function politicaDeSeguranca(opcoes: {
  nonce: string;
  area: AreaDaPagina;
  /**
   * ⚠️ `true` apenas em DESENVOLVIMENTO, e por um motivo medido.
   *
   * O recarregamento a quente do Next avalia string como JavaScript (`eval`). Com bloqueio ligado e sem
   * `'unsafe-eval'`, o servidor de desenvolvimento para de hidratar: a página aparece e nada funciona. Foi
   * exatamente o que aconteceu ao testar aqui, e o console mostrou
   * `EvalError ... _next/static/chunks/main-app.js`.
   *
   * O build de PRODUÇÃO não usa `eval` — por isso a permissão fica presa ao desenvolvimento em vez de
   * entrar na política de todo mundo. Quem decide é o `middleware`, lendo `NODE_ENV`.
   */
  desenvolvimento?: boolean;
  /** Em modo relatório, `upgrade-insecure-requests` é ignorado pelo navegador e vira erro no console. */
  modo?: ModoDaCsp;
}): string {
  const { nonce, area, desenvolvimento = false, modo = "relatorio" } = opcoes;

  /**
   * ── script-src ────────────────────────────────────────────────────────────
   * Área privada: `'nonce-…'` autoriza os scripts do Next (ele lê o nonce da própria política e o aplica),
   * e a impressão digital autoriza o único script inline escrito à mão, o do tema.
   *
   * `'self'` acompanha porque os pedaços de JavaScript que o Next carrega na navegação vêm do mesmo
   * domínio. Não se usa `'strict-dynamic'`: ele fecha um pouco mais, mas ANULA o `'self'`, e aí o script do
   * tema e os pedaços carregados depois precisariam de nonce que a página estática não tem — trocaria uma
   * defesa por um site quebrado.
   *
   * `'unsafe-eval'` NÃO entra em nenhuma das duas. A auditoria confirmou zero `eval(`, zero
   * `new Function(` e zero script de terceiro no projeto — é a permissão mais perigosa da CSP e aqui ela
   * simplesmente não é necessária.
   */
  const eval_ = desenvolvimento ? " 'unsafe-eval'" : "";
  const script =
    area === "privada"
      ? `script-src 'self' 'nonce-${nonce}' '${HASH_DO_SCRIPT_DO_TEMA}'${eval_}`
      : `script-src 'self' 'unsafe-inline'${eval_}`;

  return [
    "default-src 'self'",
    script,
    /**
     * ── style-src: 'unsafe-inline' é decisão consciente ─────────────────────
     * O React escreve `style={{...}}` como ATRIBUTO no HTML, e nonce não vale para atributo — só para tag.
     * São 22 desses em 9 arquivos: a barra de progresso do painel, as bordas das páginas de planos, os
     * gradientes dos cartões e o fundo institucional. Sem isto, o layout quebra visivelmente para quem está
     * decidindo assinar.
     *
     * `'unsafe-inline'` em ESTILO é risco muito menor que em SCRIPT: estilo não executa código nem lê
     * sessão. Ser rígido em script e tolerante em estilo é o desenho correto, não atalho. Trocar os 22
     * atributos por classes é possível depois, sem pressa — e só então isto sai.
     */
    "style-src 'self' 'unsafe-inline'",
    /**
     * `data:` é OBRIGATÓRIO: o QR code do segundo fator é gerado como `data:image/...` na própria página.
     * Sem isto, a tela de ativação do 2FA carrega e o QR não aparece — sem erro, só um espaço vazio, e
     * ninguém consegue ativar o segundo fator. Imagem não executa código; o perigoso seria `data:` em
     * script, o que não está aqui.
     */
    "img-src 'self' data:",
    /** As três fontes são arquivos locais; nenhum Google Fonts. */
    "font-src 'self'",
    /** Toda chamada de tela é caminho relativo da própria aplicação. Asaas e DataJud são falados pelo SERVIDOR. */
    "connect-src 'self'",
    /** Não existe iframe no projeto, e o pagamento é navegação de página cheia para o Asaas. */
    "frame-src 'none'",
    /**
     * Fecha a porta de embutir a tela de login do Prescrição Pro dentro de um site falso para capturar
     * senha de advogado. Sai de graça: não há iframe nem uso embutido.
     */
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    /** Todo formulário é de mesma origem — conferido um por um na auditoria. */
    "form-action 'self'",
    /**
     * Só no modo bloqueio: em modo relatório o navegador IGNORA esta diretiva e escreve um erro no console
     * dizendo isso — erro que apareceria para todo cliente e não significaria nada.
     */
    ...(modo === "bloqueio" ? ["upgrade-insecure-requests"] : []),
    `report-uri ${ROTA_DO_RELATORIO}`,
    `report-to csp`,
  ].join("; ");
}

/**
 * Caminhos que recebem a política FORTE.
 *
 * É a mesma lista que o middleware usa para exigir sessão: onde há dado de cliente, há política forte. A
 * lista fica aqui para o teste poder conferi-la contra a do middleware — se as duas divergirem, alguma área
 * privada nova ficaria com a política fraca sem ninguém notar.
 */
export const AREAS_PRIVADAS = [
  "/painel",
  "/nova-analise",
  "/analises",
  "/creditos",
  "/configuracoes",
  "/suporte",
  "/assinatura",
  "/admin",
] as const;

export function areaDoCaminho(pathname: string): AreaDaPagina {
  const privada = AREAS_PRIVADAS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return privada ? "privada" : "publica";
}
