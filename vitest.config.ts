import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: true,
    /**
     * ⚠️ 20 segundos por teste, em vez dos 5 padrão.
     *
     * ── O que aconteceu ──────────────────────────────────────────────────────
     * Rodando a suíte a partir de banco ZERADO, um caso de troca de senha falhou por TEMPO ESGOTADO — e
     * passou na segunda rodada. É o pior sintoma possível, e o CONTRIBUTING.md avisa sobre ele justamente porque
     * some quando se olha.
     *
     * Medido: o caso leva ~1,5s isolado. O limite era 5s. A conta não fecha na primeira rodada depois de
     * zerar, porque ali tudo é mais caro ao mesmo tempo — o cluster acabou de ser criado, as migrações
     * acabaram de rodar, o cache de arquivos está frio e 69 arquivos de teste disputam a máquina. Some a isso
     * o `bcrypt`, que é lento POR PROJETO (é o que protege a senha), e a margem de 3,5s desaparece.
     *
     * ── Por que mexer no limite é o conserto certo, e não maquiagem ───────────
     * Nada ficou mais lento: o caminho de troca de senha grava uma linha de auditoria, e a mudança feita
     * nessa função só acrescenta trabalho quando a gravação FALHA. O limite de 5s é que era apertado para uma
     * suíte que fala com Postgres de verdade e usa hash de senha real.
     *
     * O que NÃO se fez: repetir o teste até passar, nem afrouxar a asserção. Teste que passa por insistência
     * não prova nada — e este projeto já pagou por asserção afrouxada "por honestidade".
     *
     * 20s é folga de mais de dez vezes o medido, e ainda deixa um teste realmente travado falhar rápido.
     */
    testTimeout: 20_000,
    /**
     * OCR desligado por padrão na suíte.
     *
     * `extractText` chama o OCR como recuo quando o PDF é digitalizado, e cada
     * página custa 1-2s de Ghostscript + Tesseract. Isso tornaria os testes de
     * DIAGNÓSTICO — que só verificam a contagem de páginas legíveis — lentos e
     * dependentes de dois binários externos. O caminho do OCR é exercitado
     * diretamente em tests/ocr.test.ts, que liga a variável.
     */
    /**
     * E-mail sempre no driver "console" na suíte.
     *
     * Sem isto, os testes que exercitam o webhook de pagamento chamavam a API
     * REAL do Resend — o `.env` da máquina define EMAIL_DRIVER=resend. Duas
     * consequências ruins: (1) a suíte falhava por motivo alheio ao código
     * (chave em modo de teste recusa destinatário arbitrário), e (2) com uma
     * chave de produção ela dispararia e-mails de verdade para endereços
     * inventados (`test-asaas-*@exemplo.local`), gerando bounces que sujam a
     * reputação do domínio de envio.
     *
     * Teste não fala com serviço externo. O driver "console" só imprime.
     */
    env: { OCR_ENABLED: "false", EMAIL_DRIVER: "console" },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      /**
       * `server-only` neutralizado na suíte — ver tests/apoio/server-only-noop.ts para o motivo
       * completo. Em resumo: a trava vale no build do Next, e no processo de teste nós somos o
       * servidor. Sem este apelido, 52 arquivos de teste param de carregar.
       */
      "server-only": fileURLToPath(new URL("./tests/apoio/server-only-noop.ts", import.meta.url)),
    },
  },
});
