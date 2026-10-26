import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Travas da Etapa 2 do endurecimento — arquivo enviado pelo usuário e execução de conteúdo hostil.
 *
 * ── O que NÃO está aqui, e por quê ────────────────────────────────────────────
 * Ghostscript e Tesseract não estão instalados na máquina onde isto foi escrito, e a suíte pula os testes
 * de OCR quando faltam. Então não há aqui nenhum teste que afirme "o Ghostscript aceita estas opções" —
 * isso seria inventar resultado. O que se pode travar sem o binário é a DECISÃO: quais argumentos são
 * montados, que `-dNOSAFER` não voltou, e que toda execução externa tem tempo limite. O efeito das opções
 * sobre processo escaneado real precisa ser conferido com os arquivos de teste, e a rasterização tem uma
 * segunda tentativa sem a caixa justamente porque esse efeito não pôde ser medido aqui.
 */

/** Remove comentários antes de afirmar sobre a fonte — comentário não executa. */
const semComentarios = (fonte: string) =>
  fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const { argumentosDeRasterizacao, ladoDaCaixa } = await import("../src/lib/ocr");
const { conferirAssinatura } = await import("../src/lib/documents");
const { formDataComTeto, tetoDoCorpoEmBytes } = await import("../src/lib/corpo-da-requisicao");

describe("⚠️ Ghostscript rodava com o sandbox DESLIGADO (achado crítico)", () => {
  const base = { entrada: "/tmp/x/entrada.pdf", saida: "/tmp/x/p%04d.png", ate: 10, dpi: 300 };

  it("⚠️ a contagem de páginas por Ghostscript foi APAGADA, não corrigida", () => {
    /**
     * `contarPaginas` executava `gs -dNODISPLAY -dNOSAFER -c "(caminho) (r) file runpdfbegin ..."` — com a
     * proteção que impede o interpretador de ler e escrever arquivos da máquina desligada de propósito, e
     * era a PRIMEIRA coisa a rodar sobre o PDF do cliente. Bastava o PDF não ter camada de texto, o que
     * todo documento escaneado satisfaz.
     *
     * O `-dNOSAFER` existia por um motivo técnico: aquele código abria o arquivo em TEMPO DE EXECUÇÃO, por
     * dentro do trecho PostScript, e é isso que o SAFER bloqueia. Por isso a função saiu inteira: o total
     * de páginas o `unpdf` já devolve de graça antes de o OCR ser chamado.
     */
    const fonte = semComentarios(readFileSync("src/lib/ocr.ts", "utf8"));

    expect(fonte).not.toContain("-dNOSAFER");
    expect(fonte).not.toContain("NODISPLAY");
    expect(fonte).not.toContain("runpdfbegin");
    expect(fonte).not.toContain("pdfpagecount");
    expect(fonte).not.toContain("contarPaginas");
  });

  it("⚠️ toda execução de binário externo tem tempo limite", () => {
    /**
     * Nenhuma das chamadas tinha `timeout`, e `execFile` sem `timeout` espera para sempre. Em produção o
     * OCR roda dentro do processo que serve o site, em instância única: um PDF que faça o Ghostscript
     * entrar em laço prende a máquina de todos os clientes. E o `maxDuration` do Next encerra a resposta
     * sem matar o processo filho — ele seguia consumindo CPU depois de o cliente já ter visto erro.
     */
    const fonte = semComentarios(readFileSync("src/lib/ocr.ts", "utf8"));

    /**
     * `(?<![.\w])` exclui `/regex/.exec(img)`, que é chamada de expressão regular e não de binário — a
     * primeira versão deste teste acusou justamente ela. O que se procura é o `exec` promisificado do
     * `child_process`, sempre invocado como identificador solto.
     */
    const chamadas = fonte.split(/(?<![.\w])exec\(/).slice(1);

    /**
     * A rasterização passa as opções por uma constante compartilhada (`opcoesDeExecucao`), então a palavra
     * `timeout` não aparece ao lado da chamada. Aceitar o nome da constante seria afrouxar o teste — por
     * isso a constante é conferida à parte, e cada chamada precisa apontar para ela OU trazer o teto
     * escrito ali mesmo.
     */
    const definicaoDasOpcoes = /const opcoesDeExecucao = \{[^}]*\}/.exec(fonte)?.[0] ?? "";
    expect(definicaoDasOpcoes).toContain("timeout");
    expect(definicaoDasOpcoes).toContain("killSignal");

    expect(chamadas.length).toBeGreaterThanOrEqual(3);
    for (const [i, depois] of chamadas.entries()) {
      const janela = depois.slice(0, 500);
      const temTeto = janela.includes("timeout") || janela.includes("opcoesDeExecucao");
      const temMorte = janela.includes("killSignal") || janela.includes("opcoesDeExecucao");
      expect(temTeto, `chamada ${i + 1} de exec() sem tempo limite`).toBe(true);
      expect(temMorte, `chamada ${i + 1} de exec() sem killSignal`).toBe(true);
    }
  });

  it("⚠️ -dSAFER está nas DUAS tentativas de rasterização", () => {
    /** A segunda tentativa existe para o caso de a caixa de tamanho ser incompatível — mas sem sandbox nunca. */
    expect(argumentosDeRasterizacao({ ...base, comCaixa: true })).toContain("-dSAFER");
    expect(argumentosDeRasterizacao({ ...base, comCaixa: false })).toContain("-dSAFER");
    expect(argumentosDeRasterizacao({ ...base, comCaixa: true })).not.toContain("-dNOSAFER");
    expect(argumentosDeRasterizacao({ ...base, comCaixa: false })).not.toContain("-dNOSAFER");
  });

  it("a caixa de tamanho fixo limita os pixels da página", () => {
    /**
     * `-r300` era aplicado ao tamanho que o ARQUIVO DO CLIENTE declara. Um PDF de uma página com tamanho
     * absurdo virava imagem de bilhões de pixels — e a instância tem 512 MB. Um arquivo, uma página, site
     * fora do ar. `-g` fixa o número de pixels independentemente do que o arquivo pede.
     */
    const args = argumentosDeRasterizacao({ ...base, comCaixa: true });

    expect(args).toContain("-g3508x3508");
    expect(args).toContain("-dPDFFitPage");
    /** Reduz para caber; nunca corta. `-dFIXEDMEDIA` sem `-dPDFFitPage` cortaria a página. */
    expect(args).not.toContain("-dFIXEDMEDIA");
  });

  it("a caixa é QUADRADA — página deitada não perde resolução", () => {
    /**
     * `-dPDFFitPage` preserva a proporção: numa caixa quadrada, A4 em pé encosta na altura e A4 deitado
     * encosta na largura, então os dois saem nos mesmos 300 DPI. Caixa retangular em pé encolheria toda
     * página em paisagem — e tabela de cálculo de débito fiscal em paisagem é comum.
     */
    const lado = ladoDaCaixa(300);
    const args = argumentosDeRasterizacao({ ...base, comCaixa: true });
    const caixa = args.find((a) => a.startsWith("-g"))!;

    expect(caixa).toBe(`-g${lado}x${lado}`);
    /** 297 mm (lado maior do A4) a 300 DPI. */
    expect(lado).toBe(3508);
    expect(ladoDaCaixa(150)).toBe(1754);
  });

  it("a segunda tentativa larga só a caixa, e o recorte de páginas continua", () => {
    const semCaixa = argumentosDeRasterizacao({ ...base, comCaixa: false });

    expect(semCaixa.some((a) => a.startsWith("-g"))).toBe(false);
    expect(semCaixa).not.toContain("-dPDFFitPage");
    expect(semCaixa).toContain("-dLastPage=10");
    expect(semCaixa).toContain("-r300");
  });
});

describe("⚠️ o tipo do arquivo era acreditado, não lido (achado M-5)", () => {
  const PDF = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj", "latin1");
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  it("o arquivo que é o que diz ser passa", () => {
    expect(conferirAssinatura("application/pdf", PDF)).toBeNull();
    expect(conferirAssinatura("image/png", PNG)).toBeNull();
    expect(conferirAssinatura("image/jpeg", JPEG)).toBeNull();
  });

  it("⚠️ declarar 'application/pdf' não basta mais", () => {
    /**
     * A validação usava `file.type`, que é o Content-Type escrito na parte do formulário — escolhido por
     * quem envia. Qualquer arquivo (vídeo, executável, conteúdo ilícito) entrava no bucket pago do produto
     * bastando declarar PDF. O dano é jurídico: o fornecedor passa a ser depositário de conteúdo arbitrário
     * de terceiro, pagando o armazenamento, sem meio técnico de saber que aquilo não é um processo.
     */
    const executavel = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]);
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

    expect(conferirAssinatura("application/pdf", executavel)).toMatch(/não é um PDF de verdade/);
    expect(conferirAssinatura("application/pdf", zip)).toMatch(/não é um PDF de verdade/);
    expect(conferirAssinatura("application/pdf", PNG)).toMatch(/não é um PDF de verdade/);
    /** Trocar o rótulo entre dois formatos aceitos também é recusado. */
    expect(conferirAssinatura("image/png", JPEG)).toMatch(/não é um/);
  });

  it("tolera lixo antes do cabeçalho — PDF remontado por sistema processual existe", () => {
    /**
     * Exigir a assinatura no byte zero recusaria arquivo legítimo: alguns sistemas processuais devolvem PDF
     * com lixo à frente, e é justamente o público deste produto que sobe esse arquivo. O `unpdf` tolera,
     * então a janela existe — mas é curta.
     */
    const comLixo = Buffer.concat([Buffer.alloc(900, 0x20), PDF]);
    expect(conferirAssinatura("application/pdf", comLixo)).toBeNull();
  });

  it("⚠️ mas a janela tem fim — assinatura muito depois do início é recusada", () => {
    /** Sem limite, bastaria anexar `%PDF-` no fim de qualquer arquivo para passar. */
    const longe = Buffer.concat([Buffer.alloc(4000, 0x20), PDF]);
    expect(conferirAssinatura("application/pdf", longe)).toMatch(/não é um PDF de verdade/);
  });

  it("formato sem assinatura catalogada não é bloqueado aqui", () => {
    /** Quem decide o que entra é `validateUpload`; esta função só confere o que sabe conferir. */
    expect(conferirAssinatura("application/vnd.oasis.opendocument.text", Buffer.from("qualquer"))).toBeNull();
  });

  it("arquivo vazio ou curto é recusado sem lançar", () => {
    expect(conferirAssinatura("application/pdf", Buffer.alloc(0))).toMatch(/não é um PDF/);
    expect(conferirAssinatura("application/pdf", Buffer.from("%PD"))).toMatch(/não é um PDF/);
  });
});

describe("⚠️ o corpo da requisição entrava inteiro na memória (achado A-2)", () => {
  /** Monta um multipart de verdade, para o teste exercitar a mesma análise que a rota usa. */
  const multipart = (bytesDoArquivo: number) => {
    const fronteira = "----ptp-teste-fronteira";
    const cabeca =
      `--${fronteira}\r\n` +
      `Content-Disposition: form-data; name="analysisId"\r\n\r\nabc123\r\n` +
      `--${fronteira}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="processo.pdf"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`;
    const corpo = Buffer.concat([
      Buffer.from(cabeca, "utf8"),
      Buffer.alloc(bytesDoArquivo, 0x41),
      Buffer.from(`\r\n--${fronteira}--\r\n`, "utf8"),
    ]);
    return { corpo, tipo: `multipart/form-data; boundary=${fronteira}` };
  };

  const pedido = (corpo: Buffer, tipo: string, contentLength?: string) =>
    new Request("http://localhost/api/documentos", {
      method: "POST",
      headers: { "content-type": tipo, ...(contentLength ? { "content-length": contentLength } : {}) },
      /**
       * `Uint8Array` e não `Buffer`: o tipo de `BodyInit` não aceita `Buffer`, e o `Request` transforma
       * qualquer corpo em fluxo de leitura de todo jeito — então `formDataComTeto` continua exercitando a
       * contagem byte a byte, que é o que interessa medir.
       */
      body: new Uint8Array(corpo),
    });

  it("envio normal passa e é analisado", async () => {
    const { corpo, tipo } = multipart(2048);
    const r = await formDataComTeto(pedido(corpo, tipo));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.formData.get("analysisId")).toBe("abc123");
    expect(r.formData.get("file")).toBeInstanceOf(File);
  });

  it("recusa pelo tamanho DECLARADO sem ler byte nenhum", async () => {
    const { corpo, tipo } = multipart(64);
    const r = await formDataComTeto(pedido(corpo, tipo, String(tetoDoCorpoEmBytes() + 1)));

    expect(r).toMatchObject({ ok: false, status: 413 });
  });

  it("⚠️ recusa pelos bytes REAIS mesmo quando o cabeçalho MENTE", async () => {
    /**
     * Este é o teste que importa. `Content-Length` é declarado por quem envia: uma defesa que só olha o
     * cabeçalho é contornada mentindo nele. A contagem acontece durante a leitura, então o consumo fica
     * limitado ao teto mesmo com cabeçalho falso — e o fluxo é cancelado, para não continuar recebendo o
     * resto depois de já ter decidido recusar.
     */
    const teto = tetoDoCorpoEmBytes();
    const { corpo, tipo } = multipart(teto + 4096);
    const r = await formDataComTeto(pedido(corpo, tipo, "512"));

    expect(r).toMatchObject({ ok: false, status: 413 });
    if (r.ok) return;
    expect(r.erro).toMatch(/excede o limite/);
  });

  it("o teto do envio é menor que arquivos × tamanho por arquivo", async () => {
    /**
     * É esta desigualdade que fecha a conta da memória: 20 arquivos de 25 MB dariam 500 MB numa requisição
     * só, numa instância de 512 MB que atende todos os clientes ao mesmo tempo.
     */
    const { env } = await import("../src/lib/env");
    const somaDosArquivos = env.upload.maxFiles * env.upload.maxFileMb * 1024 * 1024;

    expect(tetoDoCorpoEmBytes()).toBeLessThan(somaDosArquivos);
  });

  it("corpo que não é multipart é recusado com 400, não com erro dentro da rota", async () => {
    const r = await formDataComTeto(
      new Request("http://localhost/api/documentos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      }),
    );

    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("⚠️ as duas rotas de envio usam o teto — nenhuma chama req.formData() direto", async () => {
    /**
     * Travar a função não basta: o defeito volta se alguém escrever `await req.formData()` numa rota nova
     * ou de volta numa destas. Foi assim que ele existia.
     */
    for (const rota of ["src/app/api/documentos/route.ts", "src/app/api/analises/automatica/route.ts"]) {
      const fonte = semComentarios(readFileSync(rota, "utf8"));
      expect(fonte, rota).toContain("formDataComTeto");
      expect(fonte, rota).not.toMatch(/req\.formData\(\)/);
    }
  });
});
