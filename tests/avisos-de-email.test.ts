import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

/**
 * Os e-mails que a conta dispara — e por que eles precisam de teste próprio.
 *
 * ── O achado que criou este arquivo ───────────────────────────────────────────
 * Nenhum teste do projeto observava ENVIO de e-mail. Consequência apontada pela revisão: o aviso
 * ao endereço ANTIGO — que é a mitigação de segurança da troca de e-mail, a única defesa depois
 * de a senha ter vazado — podia ser apagado do código e a suíte inteira continuaria verde.
 *
 * Guarda de segurança sem teste é guarda que a próxima refatoração remove sem ninguém notar. E
 * aqui o conteúdo importa tanto quanto o envio: o aviso precisa dizer PARA ONDE a troca vai (é
 * como a vítima reconhece que não foi ela) e que trocar a senha CANCELA o pedido (é a instrução
 * que salva a conta). Uma frase errada aí custa a conta de alguém.
 *
 * ── Como o envio é observado ──────────────────────────────────────────────────
 * `sendEmail` é substituído e as chamadas ficam guardadas. É o único jeito de afirmar algo sobre
 * o conteúdo: com o driver de console, a mensagem vai para a saída e o teste não a vê.
 */

const enviados = vi.hoisted(() => [] as { to: string; subject: string; text?: string; html?: string }[]);

vi.mock("@/lib/email", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...real,
    sendEmail: async (m: { to: string; subject: string; text?: string; html?: string }) => {
      enviados.push(m);
    },
  };
});

const { pedirTrocaDeEmail, confirmarTrocaDeEmail } = await import("../src/lib/troca-de-email");
const { emitirVerificacaoDeEmail } = await import("../src/lib/verificacao-email");
const { hashPassword } = await import("../src/lib/password");

const prisma = new PrismaClient();
const PREFIXO = "test-avisos";
const SENHA = "SenhaForte#2026";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

async function limpar() {
  const users = await prisma.user.findMany({
    where: { OR: [{ email: { startsWith: PREFIXO } }, { pendingEmail: { startsWith: PREFIXO } }] },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.securityEvent.deleteMany({ where: { email: { startsWith: PREFIXO } } });
}

beforeEach(async () => {
  enviados.length = 0;
  await limpar();
});

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

async function conta(sufixo: string) {
  return prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Pessoa ${sufixo}`,
      passwordHash: await hashPassword(SENHA),
      role: "CLIENTE",
      status: "ATIVO",
      emailVerifiedAt: new Date(),
    },
  });
}

const paraQuem = (endereco: string) => enviados.filter((m) => m.to === endereco);
const corpoDe = (m: { text?: string; html?: string }) => `${m.text ?? ""} ${m.html ?? ""}`;

describe("pedido de troca de e-mail", () => {
  it("manda DOIS e-mails: confirmação ao endereço novo e aviso ao ANTIGO", async () => {
    const user = await conta("dois");
    const novo = `${PREFIXO}-dois-novo@exemplo.local`;

    await pedirTrocaDeEmail(user.id, novo, SENHA);

    expect(paraQuem(novo)).toHaveLength(1);
    /**
     * O aviso ao endereço antigo é a mitigação de segurança da troca: é por ele que o dono
     * legítimo descobre um pedido que não fez, enquanto ainda dá para reagir. Sem este teste,
     * apagá-lo do código não quebraria nada visível.
     */
    expect(paraQuem(user.email)).toHaveLength(1);
  });

  it("o aviso ao antigo diz PARA ONDE a troca vai", async () => {
    // É como a vítima reconhece que o pedido não é dela: um endereço que ela não digitou.
    const user = await conta("para-onde");
    const novo = `${PREFIXO}-para-onde-novo@exemplo.local`;

    await pedirTrocaDeEmail(user.id, novo, SENHA);

    expect(corpoDe(paraQuem(user.email)[0]!)).toContain(novo);
  });

  it("⚠️ o aviso ao antigo diz que trocar a senha CANCELA o pedido", async () => {
    /**
     * A frase que salva a conta. Enquanto trocar a senha não cancelava, este texto mandava a
     * vítima fazer algo inútil e ela perdia a conta obedecendo. Agora a instrução é verdadeira, e
     * este teste é o que impede as duas metades de se separarem de novo: se alguém remover o
     * cancelamento, o outro arquivo de teste falha; se alguém reescrever a frase, este falha.
     */
    const user = await conta("cancela-frase");

    await pedirTrocaDeEmail(user.id, `${PREFIXO}-cancela-frase-novo@exemplo.local`, SENHA);

    const corpo = corpoDe(paraQuem(user.email)[0]!).toLowerCase();
    expect(corpo).toContain("troque sua senha");
    expect(corpo).toContain("cancela");
  });

  it("a confirmação vai para o endereço NOVO, nunca para o atual", async () => {
    /**
     * Se fosse para o atual, o link provaria controle do endereço que a pessoa já tem — e a troca
     * deixaria de exigir prova sobre o destino, que é o ponto todo.
     */
    const user = await conta("destino");
    const novo = `${PREFIXO}-destino-novo@exemplo.local`;

    await pedirTrocaDeEmail(user.id, novo, SENHA);

    expect(corpoDe(paraQuem(novo)[0]!)).toContain("confirmar-troca-email?token=");
    expect(corpoDe(paraQuem(user.email)[0]!)).not.toContain("confirmar-troca-email?token=");
  });

  it("senha errada não manda e-mail nenhum", async () => {
    // Senão a rota seria um jeito de mandar e-mail nosso sem nem saber a senha.
    const user = await conta("sem-senha-certa");

    await pedirTrocaDeEmail(user.id, `${PREFIXO}-nao-deve-receber@exemplo.local`, "errada");

    expect(enviados).toHaveLength(0);
  });
});

describe("troca confirmada", () => {
  it("avisa o endereço ANTIGO de que a troca foi feita", async () => {
    /**
     * São dois avisos diferentes de propósito: "alguém pediu" e "aconteceu" pedem reações
     * diferentes. Quem foi vítima precisa saber que perdeu o controle, não só que houve tentativa.
     */
    const user = await conta("feita");
    const novo = `${PREFIXO}-feita-novo@exemplo.local`;
    await pedirTrocaDeEmail(user.id, novo, SENHA);
    const registro = await prisma.authToken.findFirstOrThrow({
      where: { userId: user.id, type: "TROCA_EMAIL", usedAt: null },
    });
    await prisma.authToken.update({ where: { id: registro.id }, data: { tokenHash: hash("token-feita") } });
    enviados.length = 0;

    await confirmarTrocaDeEmail("token-feita");

    const aviso = paraQuem(user.email);
    expect(aviso).toHaveLength(1);
    expect(corpoDe(aviso[0]!)).toContain(novo);
    expect(corpoDe(aviso[0]!).toLowerCase()).toContain("suporte");
  });
});

describe("confirmação de cadastro", () => {
  it("o link vai para o endereço da conta", async () => {
    const user = await conta("cadastro");

    await emitirVerificacaoDeEmail({ id: user.id, email: user.email, name: user.name });

    expect(corpoDe(paraQuem(user.email)[0]!)).toContain("verificar-email?token=");
  });

  it("falha no envio devolve `enviado: false` em vez de estourar", async () => {
    /**
     * O caminho que nenhum teste exercitava. Quem chama precisa poder dizer a verdade ao cliente —
     * prometer um e-mail que não saiu é o que faz a pessoa esperar por nada.
     */
    const user = await conta("falha-envio");
    const email = await import("@/lib/email");
    const espia = vi.spyOn(email, "sendEmail").mockRejectedValueOnce(new Error("provedor fora"));

    try {
      const r = await emitirVerificacaoDeEmail({ id: user.id, email: user.email, name: user.name });
      expect(r.enviado).toBe(false);
      expect(r.erro).toContain("provedor fora");
    } finally {
      espia.mockRestore();
    }

    // E o link foi criado de qualquer forma: o cliente pode pedir reenvio sem ficar sem token.
    expect(
      await prisma.authToken.count({ where: { userId: user.id, type: "VERIFICACAO_EMAIL", usedAt: null } }),
    ).toBe(1);
  });
});
