import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/**
 * Content-Security-Policy — a rede que transforma uma falha de escape em nada.
 *
 * ── O que foi conferido em NAVEGADOR, e o que estes testes travam ─────────────
 * A política foi exercitada num navegador real, com o BLOQUEIO ligado, antes de existir este arquivo. O que
 * se mediu:
 *
 *  - dos 9 scripts inline da página, 8 receberam o nonce automaticamente (o Next o lê da própria política) e
 *    os 7 scripts externos também. O único sem nonce é o do tema, autorizado pela impressão digital — e ele
 *    EXECUTOU, porque a classe `dark` apareceu no `<html>`;
 *  - a hidratação do React foi medida nos dois estados: com relatório, 8 chaves internas na raiz e 3 no
 *    campo de e-mail; com bloqueio, no primeiro teste, ZERO — a página viva e inerte que se queria evitar;
 *  - o console apontou a causa: `EvalError ... _next/static/chunks/main-app.js`, que é o recarregamento a
 *    quente do servidor de DESENVOLVIMENTO avaliando string como JavaScript. Build de produção não faz isso.
 *    Com `'unsafe-eval'` liberado só em desenvolvimento, a hidratação em modo bloqueio voltou a 8 e 3 —
 *    igual à linha de base, e sem nenhuma violação no console.
 *
 * Estes testes travam as DECISÕES que aquela medição validou. O que eles não podem fazer é rodar um
 * navegador; por isso o modo padrão é relatório, e virar o bloqueio é decisão do dono.
 */

const { politicaDeSeguranca, areaDoCaminho, nomeDoCabecalho, AREAS_PRIVADAS, ROTA_DO_RELATORIO } = await import(
  "../src/lib/csp"
);
const { SCRIPT_DO_TEMA, HASH_DO_SCRIPT_DO_TEMA } = await import("../src/lib/tema-inicial");

const semComentarios = (fonte: string) =>
  fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const diretivas = (politica: string) =>
  Object.fromEntries(
    politica.split(";").map((d) => {
      const [nome, ...valores] = d.trim().split(/\s+/);
      return [nome, valores.join(" ")];
    }),
  ) as Record<string, string>;

const privada = (extra: Record<string, unknown> = {}) =>
  politicaDeSeguranca({ nonce: "NONCE-DE-TESTE", area: "privada", ...extra });
const publica = (extra: Record<string, unknown> = {}) =>
  politicaDeSeguranca({ nonce: "NONCE-DE-TESTE", area: "publica", ...extra });

describe("⚠️ a impressão digital do script do tema tem de bater", () => {
  it("⚠️ se este teste falhou, cole o hash da mensagem em tema-inicial.ts", () => {
    /**
     * O script do tema é inline por necessidade — precisa rodar antes da primeira pintura. A política o
     * autoriza pela impressão digital do conteúdo. Mudar o script sem atualizar o hash faz o navegador
     * bloqueá-lo EM SILÊNCIO: nada de erro, só o tema voltando a piscar em toda página. Este teste é o que
     * transforma esse silêncio em falha visível.
     */
    const real = "sha256-" + createHash("sha256").update(SCRIPT_DO_TEMA, "utf8").digest("base64");

    expect(HASH_DO_SCRIPT_DO_TEMA, `hash correto do script do tema: ${real}`).toBe(real);
  });

  it("o layout usa a constante, e não o texto escrito de novo", () => {
    /** Impressão digital só bate se o texto existir em um lugar só. */
    const layout = semComentarios(readFileSync("src/app/layout.tsx", "utf8"));

    expect(layout).toContain("SCRIPT_DO_TEMA");
    expect(layout).not.toContain("localStorage.getItem('ptp-tema')");
  });

  it("a política privada autoriza esse hash", () => {
    expect(diretivas(privada())["script-src"]).toContain(HASH_DO_SCRIPT_DO_TEMA);
  });
});

describe("⚠️ script-src: o que pode e o que nunca pode", () => {
  it("⚠️ 'unsafe-eval' NUNCA entra em produção — nem na área privada, nem na pública", () => {
    /**
     * É a permissão mais perigosa da CSP: com ela, texto vindo de fora pode virar código. A auditoria
     * confirmou zero `eval(` e zero `new Function(` no projeto, então ela não é necessária. Só o
     * recarregamento a quente do DESENVOLVIMENTO precisa dela, e lá não há dado real.
     */
    expect(privada()).not.toContain("unsafe-eval");
    expect(publica()).not.toContain("unsafe-eval");
    expect(privada({ desenvolvimento: false })).not.toContain("unsafe-eval");
  });

  it("em desenvolvimento 'unsafe-eval' entra, porque sem ele o servidor local não hidrata", () => {
    expect(privada({ desenvolvimento: true })).toContain("'unsafe-eval'");
    expect(publica({ desenvolvimento: true })).toContain("'unsafe-eval'");
  });

  it("⚠️ a área privada NÃO aceita script inline solto", () => {
    /** É onde moram dado de cliente e sessão de advogado: ali script inline só entra com nonce ou hash. */
    const script = diretivas(privada())["script-src"]!;

    expect(script).not.toContain("unsafe-inline");
    expect(script).toContain("'nonce-NONCE-DE-TESTE'");
  });

  it("a área pública aceita inline — e o motivo é o formato dela, não descuido", () => {
    /**
     * As 10 páginas públicas são geradas no BUILD, quando requisição não existe: os scripts de arranque do
     * Next já estão no HTML sem nonce. Exigir nonce nelas deixaria a vitrine viva e inerte para todo
     * visitante — o funil de vendas morto para proteger páginas que só têm texto institucional.
     */
    const script = diretivas(publica())["script-src"]!;

    expect(script).toContain("'unsafe-inline'");
    expect(script).not.toContain("nonce-");
  });

  it("não usa 'strict-dynamic', que anularia o 'self'", () => {
    /** Com `'strict-dynamic'`, `'self'` é ignorado — e aí os pedaços que o Next carrega depois quebrariam. */
    expect(privada()).not.toContain("strict-dynamic");
    expect(publica()).not.toContain("strict-dynamic");
  });
});

describe("as diretivas que valem para as duas políticas", () => {
  it("⚠️ img-src aceita data: — sem isso ninguém ativa o segundo fator", () => {
    /**
     * O QR code do 2FA é gerado como `data:image/...` na própria página. Com `img-src 'self'` puro, a tela
     * carrega e o QR não aparece: nenhum erro, só um espaço vazio. Ninguém descobre até um cliente reclamar.
     */
    for (const p of [privada(), publica()]) expect(diretivas(p)["img-src"]).toBe("'self' data:");
  });

  it("data: NÃO é aceito em script — é onde ele seria perigoso", () => {
    for (const p of [privada(), publica()]) expect(diretivas(p)["script-src"]).not.toContain("data:");
  });

  it("⚠️ frame-ancestors 'none' fecha o login dentro de site falso", () => {
    /** Não há iframe no projeto e o pagamento é navegação de página cheia: esta proteção sai de graça. */
    for (const p of [privada(), publica()]) {
      expect(diretivas(p)["frame-ancestors"]).toBe("'none'");
      expect(diretivas(p)["frame-src"]).toBe("'none'");
    }
  });

  it("as demais diretivas fecham em 'self' ou 'none'", () => {
    for (const p of [privada(), publica()]) {
      const d = diretivas(p);
      expect(d["default-src"]).toBe("'self'");
      expect(d["connect-src"]).toBe("'self'");
      expect(d["font-src"]).toBe("'self'");
      expect(d["object-src"]).toBe("'none'");
      expect(d["base-uri"]).toBe("'self'");
      expect(d["form-action"]).toBe("'self'");
    }
  });

  it("style-src aceita inline, por causa dos 22 atributos style do React", () => {
    /**
     * O React escreve `style={{...}}` como ATRIBUTO, e nonce não vale para atributo. Sem isto, quebram a
     * barra de progresso do painel, as bordas das páginas de planos e o fundo institucional. Estilo não
     * executa código nem lê sessão — ser rígido em script e tolerante em estilo é o desenho, não atalho.
     */
    for (const p of [privada(), publica()]) expect(diretivas(p)["style-src"]).toBe("'self' 'unsafe-inline'");
  });

  it("aponta para onde mandar as violações", () => {
    expect(privada()).toContain(`report-uri ${ROTA_DO_RELATORIO}`);
    expect(privada()).toContain("report-to csp");
  });
});

describe("modo relatório x modo bloqueio", () => {
  it("o padrão é RELATÓRIO: cabeçalho que não bloqueia nada", () => {
    expect(nomeDoCabecalho("relatorio")).toBe("Content-Security-Policy-Report-Only");
    expect(nomeDoCabecalho("bloqueio")).toBe("Content-Security-Policy");
  });

  it("o middleware só bloqueia com CSP_MODO=bloqueio, e o padrão é relatório", () => {
    const mw = semComentarios(readFileSync("src/middleware.ts", "utf8"));

    expect(mw).toContain('process.env.CSP_MODO === "bloqueio"');
    expect(mw).toContain('"relatorio"');
  });

  it("upgrade-insecure-requests só no bloqueio — em relatório o navegador reclama no console", () => {
    /** Medido: em modo relatório o console mostra "directive ... is ignored when delivered in a report-only policy". */
    expect(privada({ modo: "bloqueio" })).toContain("upgrade-insecure-requests");
    expect(privada({ modo: "relatorio" })).not.toContain("upgrade-insecure-requests");
  });
});

describe("⚠️ onde a política é emitida, e onde ela alcança", () => {
  it("⚠️ a CSP NÃO está no next.config — lá o nonce seria o mesmo para sempre", () => {
    /**
     * `next.config.mjs` é avaliado UMA vez, no build. Um nonce escrito ali seria idêntico para todos os
     * clientes e para sempre: o atacante leria o valor no próprio HTML e o usaria. Ficaria a aparência da
     * proteção sem a proteção — e é o erro mais fácil de cometer aqui.
     */
    const config = semComentarios(readFileSync("next.config.mjs", "utf8"));

    expect(config.toLowerCase()).not.toContain("content-security-policy");
    expect(config).not.toContain("nonce");
  });

  it("o middleware gera nonce novo por requisição", () => {
    const mw = semComentarios(readFileSync("src/middleware.ts", "utf8"));

    expect(mw).toContain("crypto.getRandomValues");
    /** A política vai também na REQUISIÇÃO: é assim que o Next descobre o nonce e o aplica nos scripts dele. */
    expect(mw).toContain('cabecalhosDaRequisicao.set("Content-Security-Policy"');
  });

  it("⚠️ o matcher alcança as páginas públicas, não só as privadas", () => {
    /**
     * Antes o middleware só rodava nas áreas privadas. Uma CSP escrita ali não alcançaria a vitrine, o login
     * nem o cadastro — as páginas mais expostas — e a proteção ficaria desigual sem ninguém notar, porque o
     * painel funcionaria.
     */
    const mw = readFileSync("src/middleware.ts", "utf8");

    expect(mw).toMatch(/matcher:\s*\[\s*"\/\(\(\?!/);
    expect(mw).toContain("_next/static");
  });

  it("⚠️ mas o REDIRECIONAMENTO de login continua restrito às áreas privadas", () => {
    /**
     * Este é o ponto delicado: se a checagem de cookie tivesse sido alargada junto com o matcher, visitante
     * não logado passaria a ser mandado para /login na home — funil de vendas morto.
     */
    const mw = semComentarios(readFileSync("src/middleware.ts", "utf8"));

    expect(mw).toContain("const needsAuth = PROTECTED.some(");
    expect(mw).toContain("if (!needsAuth)");
  });

  it("a lista de áreas privadas da política é a mesma que exige sessão", () => {
    /** Se divergirem, uma área privada nova ficaria com a política fraca sem ninguém notar. */
    const mw = readFileSync("src/middleware.ts", "utf8");
    const protegidas = /const PROTECTED = \[([^\]]+)\]/.exec(mw)?.[1] ?? "";
    const doMiddleware = [...protegidas.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();

    expect([...AREAS_PRIVADAS].sort()).toEqual(doMiddleware);
  });

  it("classifica os caminhos como o middleware classifica", () => {
    expect(areaDoCaminho("/painel")).toBe("privada");
    expect(areaDoCaminho("/analises/abc-123")).toBe("privada");
    expect(areaDoCaminho("/admin/analises")).toBe("privada");
    expect(areaDoCaminho("/")).toBe("publica");
    expect(areaDoCaminho("/planos")).toBe("publica");
    expect(areaDoCaminho("/login")).toBe("publica");
    /** Cuidado com prefixo parcial: `/analisesx` não é a área de análises. */
    expect(areaDoCaminho("/analisesx")).toBe("publica");
  });
});

describe("a regra que a auditoria mandou PRESERVAR", () => {
  /**
   * ⚠️ MENÇÃO NÃO É USO — e este bloco já falhou por confundir os dois.
   *
   * Estes testes procuram padrões proibidos com `git grep`, que enxerga comentário igual a código. Quando
   * `lib/csp.ts` e `lib/tema-inicial.ts` ganharam comentários explicando POR QUE `eval` não é necessário e
   * por que aquele `dangerouslySetInnerHTML` é seguro, os testes passaram a acusar os próprios comentários.
   *
   * Um teste que obriga a apagar a explicação para ficar verde piora o código: a explicação é o que impede
   * alguém de copiar o padrão para um lugar onde ele seria perigoso. Então o `git grep` serve apenas para
   * ACHAR CANDIDATOS, e a decisão é tomada sobre a fonte sem comentários.
   */
  const arquivosQueUsam = (padrao: string): string[] => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    let candidatos: string[] = [];
    try {
      candidatos = execSync(`git grep -l "${padrao}" -- "src/*"`, { encoding: "utf8" })
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
    } catch {
      return []; // `git grep` sai com 1 quando não encontra — é o resultado desejado
    }
    return candidatos.filter((arquivo) => semComentarios(readFileSync(arquivo, "utf8")).includes(padrao));
  };

  it("⚠️ o único dangerouslySetInnerHTML do projeto é o do tema, com texto do próprio código", () => {
    /**
     * O dono foi explícito: "NÃO QUERO DE FORMA ALGUMA ALGO QUE DEIXE HTML PERSONALIZADO EM MEUS SISTEMAS".
     * A auditoria confirmou que isso JÁ está cumprido — todo texto de cliente e toda saída de IA são
     * renderizados como texto, e o React os escapa. Este teste é o que impede a exceção de aparecer amanhã.
     */
    expect(arquivosQueUsam("dangerouslySetInnerHTML")).toEqual(["src/app/layout.tsx"]);
  });

  it("não há eval, new Function nem script de terceiro", () => {
    expect(arquivosQueUsam("eval(")).toEqual([]);
    expect(arquivosQueUsam("new Function(")).toEqual([]);
    expect(arquivosQueUsam("next/script")).toEqual([]);
  });
});
