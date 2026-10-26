import { describe, it, expect } from "vitest";

/**
 * Travas da Etapa 1 do endurecimento de segurança.
 *
 * Cada teste aqui corresponde a um achado da auditoria de 16/08/2026. O que NÃO está aqui, e por quê:
 *
 *  - A trava do pacote do navegador (achado A-1) não é testável por vitest: ela é uma falha de BUILD,
 *    verificada apontando o componente de tela de volta para o módulo de servidor e confirmando
 *    "Failed to compile". Vitest não empacota para navegador, então um teste aqui passaria nos dois
 *    estados — que é exatamente o tipo de teste que este projeto proíbe.
 *  - O aviso de FIELD_ENCRYPTION_KEY ausente (M-1) depende de `env`, construído no carregamento do
 *    módulo; testá-lo exigiria arquivo próprio só para isso, e o comportamento observável é uma linha
 *    de log. Registrado como não coberto em vez de coberto por um teste que não prova nada.
 */

const { clientIp } = await import("../src/lib/rate-limit");
/** A função REAL da rota — não uma cópia. Ver o comentário no describe do CSV. */
const { campoCsv: esc } = await import("../src/lib/csv");

/**
 * Remove comentários antes de afirmar sobre a FONTE.
 *
 * Dois testes deste arquivo já falharam por medir texto em vez de código: um acusou a frase que
 * explica a remoção da senha padrão, outro aceitou `import "server-only"` comentado. O que executa é
 * código; o comentário existe justamente para explicar por que a proteção está ali e não pode ser
 * apagado para o teste ficar verde.
 */
const semComentarios = (fonte: string) =>
  fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Constrói um pedido com os cabeçalhos que cada intermediário escreveria. */
const pedido = (h: Record<string, string>) => new Request("http://localhost/x", { headers: h });

describe("⚠️ IP de origem com CDN na frente (achado M-3)", () => {
  it("prefere CF-Connecting-IP, que é o único que a Cloudflare garante", () => {
    /**
     * A produção está atrás da Cloudflare (confirmado: `Server: cloudflare` na resposta). Nessa
     * arquitetura, `x-real-ip` e o fim do `x-forwarded-for` são endereços da borda da CDN — não do
     * visitante. Com o IP errado, o limite por IP conta por nó da CDN e o IP gravado nos consentimentos
     * de LGPD deixa de ser o do titular.
     */
    const ip = clientIp(
      pedido({
        "cf-connecting-ip": "203.0.113.7",
        "x-real-ip": "172.71.0.1",
        "x-forwarded-for": "203.0.113.7, 172.71.0.1",
      }),
    );

    expect(ip).toBe("203.0.113.7");
  });

  it("sem a CDN na frente, cai para os cabeçalhos anteriores — nada quebra se ela sair", () => {
    expect(clientIp(pedido({ "x-real-ip": "198.51.100.9" }))).toBe("198.51.100.9");
    expect(clientIp(pedido({ "x-forwarded-for": "1.2.3.4, 198.51.100.9" }))).toBe("198.51.100.9");
    expect(clientIp(pedido({}))).toBe("0.0.0.0");
  });

  it("⚠️ o cabeçalho forjado pelo cliente NÃO ganha do da Cloudflare", () => {
    /**
     * O atacante escreve `x-real-ip` e `x-forwarded-for` à vontade; `cf-connecting-ip` é sobrescrito
     * pela borda. Se a ordem se invertesse, o limite por IP voltaria a ser decorativo.
     */
    const ip = clientIp(
      pedido({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "9.9.9.9", "cf-connecting-ip": "203.0.113.7" }),
    );

    expect(ip).toBe("203.0.113.7");
  });
});

describe("⚠️ injeção de fórmula na planilha exportada (achado M-4)", () => {
  /**
   * ⚠️ Exercita `@/lib/csv`, a MESMA função que a rota executa.
   *
   * A primeira versão deste teste copiava a regra para dentro do arquivo de teste. Apagar a proteção
   * da rota deixava o teste verde — descoberto ao desligar a correção de propósito, como manda o
   * CONTRIBUTING.md. Por isso a regra virou módulo: agora desligá-la derruba estes três testes.
   */

  it("⚠️ neutraliza os cinco inícios que Excel e LibreOffice EXECUTAM", () => {
    /**
     * Quem abre a exportação é o administrador, na máquina que tem acesso ao painel. Um cliente que se
     * cadastra com o nome `=HYPERLINK(...)` planta a fórmula; abrir o arquivo executa.
     */
    for (const inicio of ["=", "+", "-", "@", "\t", "\r"]) {
      const saida = esc(`${inicio}cmd|'/c calc'!A1`);
      expect(saida.startsWith(`"'${inicio}`)).toBe(true);
    }
  });

  it("texto comum passa intacto — o escape não pode estragar o nome de ninguém", () => {
    expect(esc("Leão Amorim Tecnologia LTDA")).toBe('"Leão Amorim Tecnologia LTDA"');
    expect(esc("Silva & Souza — Advogados")).toBe('"Silva & Souza — Advogados"');
    /** Número negativo é o caso limite: começa com `-`, então é neutralizado. Preferimos isso a executar. */
    expect(esc("-39,90")).toBe(`"'-39,90"`);
  });

  it("⚠️ a ROTA usa o módulo — não pode ter escape próprio de novo", async () => {
    /**
     * Travar só a função não basta: o defeito voltaria se alguém escrevesse um escape local na rota. Foi
     * assim que ele nasceu. Aqui a fonte da rota é lida: tem de importar `@/lib/csv` e não pode declarar
     * escape próprio.
     */
    const { readFileSync } = await import("node:fs");
    const rota = semComentarios(readFileSync("src/app/api/admin/assinaturas/export/route.ts", "utf8"));
    expect(rota).toContain('from "@/lib/csv"');
    expect(rota).not.toMatch(/const\s+esc\s*=/);
  });

  it("continua escapando aspas, senão a planilha quebra de coluna", () => {
    expect(esc('Escritório "Alfa"')).toBe('"Escritório ""Alfa"""');
  });
});

describe("⚠️ chave de API não fica escrita no código (achado A-1 / item 2)", () => {
  it("o valor padrão da chave do DataJud é VAZIO", async () => {
    /**
     * A chave do CNJ é pública, então tê-la ali não vazava segredo — o problema era o PADRÃO. Valor
     * escrito em `env.ts` é texto no código e vai para o pacote do navegador quando algum componente de
     * tela puxa o módulo. Este teste trava o formato: sem valor embutido.
     */
    const { env } = await import("../src/lib/env");
    if (process.env.DATAJUD_API_KEY) return; // ambiente com a variável definida: nada a afirmar
    expect(env.datajud.apiKey).toBe("");
  });

  it("⚠️ nenhum valor padrão de env.ts parece uma credencial", async () => {
    /**
     * A trava que impede a reincidência. Se alguém escrever `get("X_API_KEY", "sk-...")`, este teste cai
     * antes de o segredo chegar a um commit — e muito antes de chegar ao navegador.
     */
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync("src/lib/env.ts", "utf8");
    const padroes = [
      /get\([^)]*,\s*"sk-[A-Za-z0-9]/,
      /get\([^)]*,\s*"sk_live_/,
      /get\([^)]*,\s*"rk_live_/,
      /get\([^)]*,\s*"whsec_/,
      /get\([^)]*,\s*"aact_/,
      /get\([^)]*,\s*"re_[A-Za-z0-9]{10}/,
      /get\([^)]*,\s*"AKIA[A-Z0-9]{10}/,
      /get\([^)]*,\s*"ghp_/,
      /get\([^)]*,\s*"[A-Za-z0-9+/]{40,}={0,2}"/,
    ];
    const encontrados = padroes.filter((p) => p.test(fonte)).map((p) => p.source);
    expect(encontrados).toEqual([]);
  });

  it("⚠️ db.ts e env.ts declaram server-only — a trava que quebra o build", async () => {
    /**
     * O teste de verdade é o build (confirmado: apontar um componente de tela de volta para o módulo de
     * servidor produz "Failed to compile"). Este teste guarda a LINHA: se alguém a remover para "resolver
     * um erro de import", o build volta a compilar em silêncio e o vazamento volta com ele.
     */
    const { readFileSync } = await import("node:fs");
    for (const arquivo of ["src/lib/db.ts", "src/lib/env.ts"]) {
      /**
       * ⚠️ Sem os comentários: a primeira versão aceitava a linha COMENTADA.
       *
       * Ao desligar a correção de propósito, comentei `// import "server-only";` e o teste continuou
       * verde — `toContain` achava o texto dentro do próprio comentário. Comentário não executa.
       */
      expect(semComentarios(readFileSync(arquivo, "utf8"))).toContain('import "server-only"');
    }
  });
});

describe("⚠️ seed não cria administrador com senha padrão (achado M-2)", () => {
  it("as duas variáveis são obrigatórias, e não há valor embutido", async () => {
    /**
     * Havia `?? "Admin@Demo123"`. Quem rodasse o seed em produção sem definir as variáveis criava um
     * administrador com senha publicada no repositório — e ela viaja dentro da imagem, então "repositório
     * privado" não protege. Testo a FONTE porque rodar o seed aqui exigiria banco e criaria dado.
     */
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync("prisma/seed.ts", "utf8");

    /**
     * Mede o CÓDIGO, não o texto do arquivo.
     *
     * A primeira versão deste teste procurava a senha no arquivo inteiro e acusou a própria frase que
     * explica a remoção dela. Comentário não executa: o que cria administrador é código. Pior, um teste
     * que proíbe citar a senha no comentário empurra para apagar a explicação — e a explicação é o que
     * impede o padrão de voltar por engano.
     */
    const codigo = semComentarios(fonte);

    // Nenhum valor embutido para senha de administrador no código executável.
    expect(codigo).not.toContain("Admin@Demo123");
    // Nenhum atalho de valor padrão, em qualquer forma: `??`, `||` ou destructuring com `=`.
    expect(codigo).not.toMatch(/SEED_ADMIN_(EMAIL|PASSWORD)\s*(\?\?|\|\||=[^=])/);
    // E a recusa continua no lugar.
    expect(codigo).toContain("Defina SEED_ADMIN_EMAIL e SEED_ADMIN_PASSWORD");
  });
});
