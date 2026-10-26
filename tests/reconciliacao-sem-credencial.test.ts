import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * A reconciliação sem credencial do Asaas — e por que este é um arquivo separado.
 *
 * ── O defeito real que este teste trava ───────────────────────────────────────
 * O cron de manutenção do Render foi criado com quatro variáveis de ambiente, e
 * `ASAAS_API_KEY` não estava entre elas. Duas tarefas dele FALAM com o Asaas:
 * `encerrarBoletosVencidos`, que pergunta se o boleto foi pago antes de encerrar, e agora
 * a reconciliação, que libera acesso de quem pagou e cujo evento se perdeu.
 *
 * Sem a chave, as duas respondem "não consegui perguntar". O efeito é invisível de fora:
 * nenhum erro, nenhuma linha vermelha, e o log dizendo "0 liberados" — indistinguível de
 * "não havia nada a liberar". Todo boleto vencido ficava adiado para sempre e nenhum
 * pagamento era recuperado, com toda a aparência de funcionamento normal.
 *
 * ── Por que arquivo próprio ───────────────────────────────────────────────────
 * `env` é montado UMA vez, na carga do módulo, a partir de `process.env`. Apagar a
 * variável no meio do arquivo não muda o valor já capturado, e o resto dos testes de
 * reconciliação precisa da chave PRESENTE para medir "tentou e conseguiu" em vez de
 * "não tentou". Ambiente diferente, arquivo diferente.
 */

delete process.env.ASAAS_API_KEY;

const { reconciliarPagamentos } = await import("../src/lib/asaas");

const prisma = new PrismaClient();
const ALERTA_SEM_CREDENCIAL = "asaas_reconciliacao_sem_credencial";

async function limpar() {
  await prisma.securityEvent.deleteMany({ where: { type: ALERTA_SEM_CREDENCIAL } });
}

beforeEach(limpar);

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

describe("reconciliação sem poder consultar o Asaas", () => {
  it("responde FALHOU — nunca 'nada a liberar'", async () => {
    const r = await reconciliarPagamentos();

    expect(r.falhou).toBe(true);
    expect(r.motivo).toContain("ASAAS_API_KEY");
    expect(r.liberadas).toBe(0);
    // Nada foi consultado: dizer o contrário seria afirmar que o período está coberto.
    expect(r.consultadas).toBe(0);
  });

  it("ALERTA, porque o sintoma externo é idêntico ao de tudo funcionando", async () => {
    await reconciliarPagamentos();

    /**
     * Registro só no banco não basta e o próprio `alertarOperacao` existe por isso:
     * ninguém abre o painel de logs por acaso. Aqui a consequência de não avisar é que a
     * rede de segurança do produto fica desligada sem que ninguém saiba.
     */
    const evento = await prisma.securityEvent.findFirstOrThrow({ where: { type: ALERTA_SEM_CREDENCIAL } });
    expect(JSON.stringify(evento.metadata)).toContain("SEM poder consultar");
  });
});
