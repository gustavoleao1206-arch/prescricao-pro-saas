/**
 * O script que aplica o tema salvo antes de a página ser pintada.
 *
 * ── Por que ele mora num módulo em vez de estar escrito no layout ─────────────
 * Ele é o ÚNICO script escrito à mão no projeto inteiro, e é inline por necessidade: precisa rodar antes da
 * primeira pintura, senão o cliente vê um clarão branco antes do tema escuro aparecer. Script em arquivo
 * externo chega tarde.
 *
 * A Content-Security-Policy autoriza script inline de duas formas: por `nonce` (valor novo a cada
 * requisição) ou por `sha256` (a impressão digital do conteúdo). Nonce não serve aqui, porque as 10 páginas
 * públicas são geradas estaticamente e não existe requisição na hora de gerá-las. Sobra a impressão
 * digital — e para a impressão digital bater, o texto do script tem de ser UM só, em um lugar só.
 *
 * Daí este módulo: o layout injeta esta constante e a política autoriza o hash dela. Mudar o script sem
 * atualizar o hash faria o navegador bloqueá-lo em silêncio (o tema voltaria a piscar), então há teste que
 * confere os dois — ver tests/hardening-etapa-2-csp.test.ts.
 *
 * ⚠️ Este é conteúdo do PRÓPRIO CÓDIGO. Nunca coloque aqui, nem em nenhum outro
 * `dangerouslySetInnerHTML`, valor que venha do banco, do cliente ou da IA.
 */
export const SCRIPT_DO_TEMA =
  "(function(){try{var t=localStorage.getItem('ptp-tema');var e=t?t==='escuro':window.matchMedia('(prefers-color-scheme: dark)').matches;if(e)document.documentElement.classList.add('dark')}catch(_){}})();";

/**
 * Impressão digital do script acima, no formato que a CSP exige.
 *
 * Escrita à mão de propósito: calcular na hora obrigaria o middleware a usar criptografia assíncrona no
 * edge a cada requisição. O teste garante que este valor corresponde ao script — se ele falhar, a mensagem
 * traz o hash novo para colar aqui.
 */
export const HASH_DO_SCRIPT_DO_TEMA = "sha256-I7J19jLDke+ZR4iaWmZ2r2vXzIA9F2xuwGZd9TgHqa0=";
