import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * O endereço pendente que ficava PRESO na conta.
 *
 * ── O achado ──────────────────────────────────────────────────────────────────
 * `pendingEmail` só saía da conta por confirmação, por cancelamento (efeito colateral de trocar a
 * senha) ou por um pedido novo. Mas o LINK vale 1 hora. Passada a hora, sobrava um estado sem saída:
 * a conta com endereço pendente, e a tela de Configurações dizendo "confirme pelo link enviado a esse
 * endereço" — prometendo um link que já não funcionava.
 *
 * Quem obedecia procurava o e-mail, clicava, era recusado, e não tinha o que fazer: pedir de volta o
 * endereço ATUAL é recusado por "email_igual", então a única forma de limpar era pedir a troca para um
 * TERCEIRO endereço qualquer, ou trocar a senha. Ninguém deduz isso, muito menos quem já está confuso
 * — e este é o caminho de quem está tentando consertar o próprio acesso para poder pagar.
 *
 * ── Por que o cancelamento NÃO pede a senha ───────────────────────────────────
 * O pedido de troca exige a senha porque APONTA a conta para outro lugar. Cancelar faz o contrário:
 * devolve a conta ao estado em que já estava. E exigir a senha aqui teria um custo assimétrico —
 * quem acabou de travar a conta errando a senha cinco vezes é exatamente quem mais precisa desfazer o
 * pedido, e ficaria sem saída nenhuma. Porta de emergência não pode depender da chave perdida.
 */

process.env.EMAIL_DRIVER = "console";

const contexto = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  const { PrismaClient: PC } = await import("@prisma/client");
  const db = new PC();
  return {
    ...real,
    requireUser: async () => {
      const u = await db.user.findUniqueOrThrow({ where: { id: contexto.userId } });
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        status: u.status,
        organizationId: u.organizationId,
        orgRole: u.orgRole,
      };
    },
  };
});

const { POST: PEDIR, DELETE: CANCELAR } = await import("../src/app/api/conta/email/route");
const { pedirTrocaDeEmail } = await import("../src/lib/troca-de-email");
const { hashPassword } = await import("../src/lib/password");

const prisma = new PrismaClient();
const PREFIXO = "test-cancelamento";
const SENHA = "SenhaForte#2026";

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

beforeEach(limpar);

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

async function conta(sufixo: string) {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Pessoa ${sufixo}`,
      passwordHash: await hashPassword(SENHA),
      role: "CLIENTE",
      status: "ATIVO",
      emailVerifiedAt: new Date(),
    },
  });
  contexto.userId = user.id;
  return user;
}

const destino = (s: string) => `${PREFIXO}-${s}-novo@exemplo.local`;

const pedidoDeCancelamento = () =>
  new Request("http://localhost/api/conta/email", {
    method: "DELETE",
    headers: { "x-real-ip": "10.9.0.1" },
  }) as never;

const pedidoDeTroca = (novoEmail: string, senha: string) =>
  new Request("http://localhost/api/conta/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-real-ip": "10.9.0.2" },
    body: JSON.stringify({ novoEmail, senha }),
  }) as never;

/** Só há link vivo enquanto ele não foi usado e a hora não passou — é o que a tela consulta. */
async function linksVivos(userId: string) {
  return prisma.authToken.count({
    where: { userId, type: "TROCA_EMAIL", usedAt: null, expiresAt: { gt: new Date() } },
  });
}

describe("o titular cancela o próprio pedido", () => {
  it("⚠️ limpa o endereço pendente E mata o link, sem pedir senha", async () => {
    const user = await conta("limpa");
    await pedirTrocaDeEmail(user.id, destino("limpa"), SENHA);
    expect(await linksVivos(user.id)).toBe(1);

    const res = await CANCELAR(pedidoDeCancelamento());
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.cancelou).toBe(true);
    const depois = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(depois.pendingEmail).toBeNull();
    expect(await linksVivos(user.id)).toBe(0);
    // O e-mail da conta não é tocado: cancelar desfaz o pedido, não muda nada.
    expect(depois.email).toBe(user.email);
  });

  it("a resposta diz o que continua valendo e o que deixou de valer", async () => {
    /**
     * Quem cancela está confuso — foi por isso que cancelou. A mensagem tem de fechar as duas
     * dúvidas numa leitura: qual e-mail é o meu agora, e o link que recebi ainda serve?
     */
    const user = await conta("mensagem");
    const novo = destino("mensagem");
    await pedirTrocaDeEmail(user.id, novo, SENHA);

    const corpo = await (await CANCELAR(pedidoDeCancelamento())).json();

    expect(corpo.data.message).toContain(user.email);
    expect(corpo.data.message).toContain(novo);
  });

  it("cancelar sem pedido pendente NÃO finge sucesso", async () => {
    /**
     * Fingir esconderia o caso em que a tela está desatualizada — e é justamente aí que a pessoa
     * precisa recarregar em vez de continuar esperando um e-mail que ninguém vai mandar.
     */
    await conta("vazio");

    const corpo = await (await CANCELAR(pedidoDeCancelamento())).json();

    expect(corpo.data.cancelou).toBe(false);
    expect(corpo.data.message).toContain("Não havia");
  });

  it("⚠️ o cancelamento pelo titular fica na auditoria, com IP e motivo próprios", async () => {
    /**
     * Sem distinguir o motivo, "cancelado pelo titular" e "cancelado porque a senha mudou" viram a
     * mesma linha — e a segunda é o rastro de uma tentativa de tomada de conta. Numa investigação,
     * confundir as duas é perder o sinal que importa.
     */
    const user = await conta("auditoria");
    await pedirTrocaDeEmail(user.id, destino("auditoria"), SENHA);

    await CANCELAR(pedidoDeCancelamento());

    const registro = await prisma.auditLog.findFirstOrThrow({
      where: { action: "conta.troca_email_cancelada", entityId: user.id },
    });
    expect((registro.metadata as Record<string, unknown>).motivo).toBe("cancelado pelo titular");
    expect(registro.ip).toBe("10.9.0.1");
  });

  it("depois de cancelar, dá para pedir a troca de novo", async () => {
    // O cancelamento não pode deixar a conta num estado que impeça a próxima tentativa.
    const user = await conta("de-novo");
    await pedirTrocaDeEmail(user.id, destino("errado"), SENHA);
    await CANCELAR(pedidoDeCancelamento());

    const res = await PEDIR(pedidoDeTroca(destino("certo"), SENHA));

    expect(res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingEmail).toBe(destino("certo"));
  });
});

describe("o estado que a tela precisa distinguir", () => {
  it("⚠️ endereço pendente COM link morto — o estado que não tinha saída", async () => {
    /**
     * É este o achado, em dados: `pendingEmail` preenchido e ZERO link vivo. A tela antiga dizia
     * "confirme pelo link enviado a esse endereço" nas duas situações, porque só olhava `pendingEmail`.
     *
     * ⚠️ HONESTIDADE SOBRE O QUE ESTE TESTE MEDE: ele demonstra que o ESTADO existe e que o
     * cancelamento é saída dele. Não exercita a consulta da página — `linksVivos` aqui é uma
     * reimplementação do mesmo `where`, e a suíte deste projeto não roda componentes nem páginas
     * (o `vitest.config.ts` usa `environment: "node"` e só inclui arquivos `.test.ts` de `tests/`).
     * Se alguém apagar a consulta de `configuracoes/page.tsx`, este teste continua verde.
     */
    const user = await conta("preso");
    await pedirTrocaDeEmail(user.id, destino("preso"), SENHA);
    await prisma.authToken.updateMany({
      where: { userId: user.id, type: "TROCA_EMAIL" },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const depois = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(depois.pendingEmail).toBe(destino("preso"));
    expect(await linksVivos(user.id)).toBe(0);

    // E o cancelamento é a saída: sai o pendente, e a conta volta a um estado coerente.
    expect((await (await CANCELAR(pedidoDeCancelamento())).json()).data.cancelou).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingEmail).toBeNull();
  });

  it("pedir de novo devolve o endereço que foi substituído", async () => {
    /**
     * O aviso na tela é renderizado pelo servidor e fica velho depois do envio. Quem pediu duas vezes
     * precisa ler no RESULTADO qual dos dois links vale, senão abre o primeiro e é recusado.
     */
    const user = await conta("substitui");
    await pedirTrocaDeEmail(user.id, destino("primeiro"), SENHA);

    const corpo = await (await PEDIR(pedidoDeTroca(destino("segundo"), SENHA))).json();

    expect(corpo.data.substituiu).toBe(destino("primeiro"));
    expect(corpo.data.message).toContain(destino("primeiro"));
    expect(corpo.data.message).toContain(destino("segundo"));
  });

  it("no primeiro pedido não há nada a substituir, e a mensagem não inventa", async () => {
    const user = await conta("primeiro-pedido");

    const corpo = await (await PEDIR(pedidoDeTroca(destino("unico"), SENHA))).json();

    expect(corpo.data.substituiu).toBeNull();
    expect(corpo.data.message).not.toContain("cancelado");
    /**
     * ⚠️ Lê o banco DE NOVO. A primeira versão afirmava `user.pendingEmail` — o objeto devolvido por
     * `conta()`, capturado ANTES do pedido —, e por isso nunca poderia falhar: era sempre nulo,
     * mesmo que a rota deixasse de gravar coisa alguma.
     */
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingEmail).toBe(
      destino("unico"),
    );
  });

  it("⚠️ pedir DUAS vezes o MESMO endereço não diz que cancelou o pedido anterior", async () => {
    /**
     * É o caminho normal de quem não recebeu o primeiro e-mail: pede de novo, para o mesmo lugar. A
     * primeira versão respondia "Enviamos um link para joao@x. O pedido anterior, para joao@x, foi
     * cancelado" — contradição na mesma frase, que faz a pessoa concluir que acabou de desfazer o que
     * pediu. Quando o endereço repete, a substituição não é informação: é ruído que assusta.
     */
    const user = await conta("mesmo-endereco");
    const mesmo = destino("mesmo");
    await pedirTrocaDeEmail(user.id, mesmo, SENHA);

    const corpo = await (await PEDIR(pedidoDeTroca(mesmo, SENHA))).json();

    expect(corpo.data.substituiu).toBe(mesmo);
    expect(corpo.data.message).not.toContain("cancelado");
    // E o pedido segue de pé, com um link só vivo.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingEmail).toBe(mesmo);
    expect(await linksVivos(user.id)).toBe(1);
  });

  it("⚠️ cancelar com endereço pendente NULO não escreve a palavra 'null' na tela", async () => {
    /**
     * O estado é alcançável: `cancelarTrocaDeEmailPendente` devolve `cancelou: true` também quando não
     * há endereço pendente mas HÁ token vivo — incoerência que a função conserta de propósito. A
     * mensagem interpolava `r.endereco` sem conferir, e o cliente lia "o link enviado para null não
     * vale mais" justamente quando estava tentando entender o que houve com a conta dele.
     */
    const user = await conta("sem-endereco");
    await pedirTrocaDeEmail(user.id, destino("sem-endereco"), SENHA);
    await prisma.user.update({ where: { id: user.id }, data: { pendingEmail: null } });

    const corpo = await (await CANCELAR(pedidoDeCancelamento())).json();

    expect(corpo.data.cancelou).toBe(true);
    expect(corpo.data.message).not.toContain("null");
    expect(corpo.data.message).toContain(user.email);
  });
});
