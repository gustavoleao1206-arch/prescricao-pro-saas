import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

/**
 * Troca do e-mail da conta pedida pelo próprio cliente.
 *
 * ── Por que passou a ser necessária ───────────────────────────────────────────
 * Contratar exige e-mail confirmado, e trocar o e-mail só era possível pelo atendimento. Com as
 * duas coisas juntas, um endereço digitado errado no cadastro virava venda que não se completa
 * até alguém do suporte agir — atrito no caminho do dinheiro, criado por um conserto.
 *
 * ── É caminho de TOMADA DE CONTA ──────────────────────────────────────────────
 * Quem controla o e-mail controla a conta, porque a recuperação de senha vai para lá. Por isso os
 * testes daqui são, na maioria, sobre o que a função RECUSA e sobre o que ela AVISA — não sobre o
 * caminho felizeiro. Cada recusa aqui é uma porta de sequestro que fica fechada.
 */

process.env.EMAIL_DRIVER = "console";

const { pedirTrocaDeEmail, confirmarTrocaDeEmail, cancelarTrocaDeEmailPendente, VALIDADE_DA_TROCA_MS } =
  await import("../src/lib/troca-de-email");
const { hashPassword } = await import("../src/lib/password");

const prisma = new PrismaClient();
const PREFIXO = "test-troca-email";
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

beforeEach(limpar);

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

async function conta(sufixo: string, opcoes: { comSenha?: boolean } = {}) {
  return prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Pessoa ${sufixo}`,
      passwordHash: opcoes.comSenha === false ? null : await hashPassword(SENHA),
      role: "CLIENTE",
      status: "ATIVO",
      emailVerifiedAt: new Date(),
    },
  });
}

/** O token não volta da função (ele vai no e-mail), então o teste o injeta e lê pelo hash. */
async function tokenDaTroca(userId: string) {
  return prisma.authToken.findFirstOrThrow({
    where: { userId, type: "TROCA_EMAIL", usedAt: null },
    orderBy: { createdAt: "desc" },
  });
}

/** Substitui o hash do token por um conhecido, para poder confirmar no teste. */
async function comTokenConhecido(userId: string, tokenEmClaro: string) {
  const registro = await tokenDaTroca(userId);
  await prisma.authToken.update({ where: { id: registro.id }, data: { tokenHash: hash(tokenEmClaro) } });
  return registro;
}

describe("o pedido de troca", () => {
  it("NÃO aplica na hora — fica pendente até a confirmação", async () => {
    const user = await conta("pendente");

    const r = await pedirTrocaDeEmail(user.id, `${PREFIXO}-novo@exemplo.local`, SENHA);

    expect(r.aceito).toBe(true);
    const depois = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    /**
     * O ponto todo. Aplicar na hora apontaria a conta para um endereço que o cliente talvez não
     * controle — por engano de digitação ou por engano de quem pediu — e ele perderia a conta,
     * porque a recuperação de senha passaria a ir para lá.
     */
    expect(depois.email).toBe(user.email);
    expect(depois.pendingEmail).toBe(`${PREFIXO}-novo@exemplo.local`);
  });

  it("⚠️ RECUSA sem a senha atual — sessão roubada não troca o e-mail", async () => {
    /**
     * A recusa mais importante do arquivo. Sem ela, o encerramento por inatividade que
     * construímos seria contornável: bastaria pegar uma tela logada esquecida aberta e apontar a
     * conta para outro endereço para tomá-la em definitivo.
     */
    const user = await conta("senha-errada");

    const r = await pedirTrocaDeEmail(user.id, `${PREFIXO}-invasor@exemplo.local`, "senha-errada");

    expect(r.aceito).toBe(false);
    expect(r.recusa).toBe("senha_incorreta");
    const depois = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(depois.pendingEmail).toBeNull();
  });

  it("senha incorreta deixa registro de segurança", async () => {
    /**
     * É a única coisa que distingue erro de digitação de ataque em curso. Sem o registro, a
     * tentativa não deixa rastro nenhum.
     */
    const user = await conta("registro");

    await pedirTrocaDeEmail(user.id, `${PREFIXO}-invasor@exemplo.local`, "errada");

    const evento = await prisma.securityEvent.findFirstOrThrow({
      where: { type: "troca_email_senha_incorreta", email: user.email },
    });
    expect((evento.metadata as Record<string, unknown>).destinoPretendido).toBe(`${PREFIXO}-invasor@exemplo.local`);
  });

  it("recusa e-mail já usado por outra conta", async () => {
    const user = await conta("origem");
    const outro = await conta("ocupado");

    const r = await pedirTrocaDeEmail(user.id, outro.email, SENHA);

    expect(r.recusa).toBe("email_em_uso");
  });

  it("recusa o e-mail que já é o da conta, e formato inválido", async () => {
    const user = await conta("mesmo");

    expect((await pedirTrocaDeEmail(user.id, user.email, SENHA)).recusa).toBe("email_igual");
    expect((await pedirTrocaDeEmail(user.id, "nao-e-email", SENHA)).recusa).toBe("email_invalido");
  });

  it("recusa conta sem senha definida", async () => {
    /**
     * A liberação manual cria o cliente sem senha e manda link para ele criar. Deixar passar sem
     * senha transformaria "sem senha" no caminho mais fácil de trocar o e-mail de uma conta.
     */
    const user = await conta("sem-senha", { comSenha: false });

    expect((await pedirTrocaDeEmail(user.id, `${PREFIXO}-x@exemplo.local`, "qualquer")).recusa).toBe("sem_senha");
  });

  it("o link vale 1 hora, não os 2 dias da confirmação de cadastro", async () => {
    /**
     * Link de troca de e-mail parado numa caixa de entrada por dois dias é uma janela aberta à
     * espera de quem leia aquela caixa.
     */
    const user = await conta("prazo");

    await pedirTrocaDeEmail(user.id, `${PREFIXO}-prazo-novo@exemplo.local`, SENHA);

    const registro = await tokenDaTroca(user.id);
    const minutos = (registro.expiresAt.getTime() - Date.now()) / 60_000;
    /**
     * ⚠️ O teto é o número 60, ESCRITO AQUI, e não `VALIDADE_DA_TROCA_MS`.
     *
     * Comparar com a própria constante fazia o teste passar com qualquer valor: se alguém pusesse
     * dois dias, o limite superior viraria 2880 e a asserção continuaria verdadeira. Era o teste
     * afirmando que a constante é igual a si mesma, com o nome de "vale 1 hora".
     *
     * O número literal é o que trava a decisão: link de troca de e-mail parado numa caixa de
     * entrada por dias é janela aberta à espera de quem leia aquela caixa. Mudar o prazo passa a
     * exigir mudar este teste, o que é o ponto — a mudança tem de ser deliberada.
     */
    expect(minutos).toBeGreaterThan(55);
    expect(minutos).toBeLessThanOrEqual(60);
    // E a constante publicada acompanha o que se acabou de medir.
    expect(VALIDADE_DA_TROCA_MS).toBe(60 * 60_000);
  });

  it("pedir de novo INVALIDA o pedido anterior", async () => {
    /**
     * Sem isto, cada tentativa deixaria mais um link vivo, cada um para um endereço diferente — e
     * um link antigo, clicado depois, moveria a conta para um destino já abandonado.
     */
    const user = await conta("substitui");
    await pedirTrocaDeEmail(user.id, `${PREFIXO}-primeiro@exemplo.local`, SENHA);
    const primeiro = await tokenDaTroca(user.id);

    await pedirTrocaDeEmail(user.id, `${PREFIXO}-segundo@exemplo.local`, SENHA);

    expect((await prisma.authToken.findUniqueOrThrow({ where: { id: primeiro.id } })).usedAt).not.toBeNull();
    expect(await prisma.authToken.count({ where: { userId: user.id, type: "TROCA_EMAIL", usedAt: null } })).toBe(1);
    // E o endereço pendente é o último pedido.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingEmail).toBe(
      `${PREFIXO}-segundo@exemplo.local`,
    );
  });
});

describe("a confirmação", () => {
  it("aplica a troca e marca o e-mail como confirmado", async () => {
    const user = await conta("aplica");
    const novo = `${PREFIXO}-aplicado@exemplo.local`;
    await pedirTrocaDeEmail(user.id, novo, SENHA);
    await comTokenConhecido(user.id, "token-aplica");

    const r = await confirmarTrocaDeEmail("token-aplica");

    expect(r.ok).toBe(true);
    const depois = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(depois.email).toBe(novo);
    expect(depois.pendingEmail).toBeNull();
    /**
     * A data é marcada porque este clique JÁ é a prova de controle do endereço novo — foi nele que
     * o link chegou. Sem marcar, a pessoa resolveria a troca e continuaria barrada para contratar,
     * que é justamente o motivo pelo qual ela trocou o e-mail.
     */
    expect(depois.emailVerifiedAt).not.toBeNull();
  });

  it("o link é de uso único — e o token é MARCADO como usado", async () => {
    const user = await conta("uso-unico");
    await pedirTrocaDeEmail(user.id, `${PREFIXO}-unico@exemplo.local`, SENHA);
    const registro = await comTokenConhecido(user.id, "token-unico");

    expect((await confirmarTrocaDeEmail("token-unico")).ok).toBe(true);
    const segunda = await confirmarTrocaDeEmail("token-unico");
    expect(segunda.ok).toBe(false);

    /**
     * ⚠️ A asserção sobre o `usedAt` foi acrescentada porque a de cima NÃO provava uso único.
     *
     * A segunda tentativa era recusada mesmo sem marcar o token: a confirmação bem-sucedida limpa
     * `pendingEmail`, e a recusa vinha por "sem_pedido". Ou seja, o teste passava com o token
     * continuando válido — e um token válido de troca é exatamente o que não pode sobrar.
     */
    expect((await prisma.authToken.findUniqueOrThrow({ where: { id: registro.id } })).usedAt).not.toBeNull();
  });

  it("token de OUTRO tipo não é aceito como troca de e-mail", async () => {
    /**
     * Nenhum teste submetia token de tipo errado. Sem a conferência de `type`, um link de
     * recuperação de senha — que chega ao endereço ANTIGO — valeria como confirmação da troca, e a
     * prova de controle do destino desapareceria.
     */
    const user = await conta("tipo-errado");
    await pedirTrocaDeEmail(user.id, `${PREFIXO}-tipo-errado-novo@exemplo.local`, SENHA);
    await prisma.authToken.create({
      data: {
        userId: user.id,
        type: "RECUPERACAO_SENHA",
        tokenHash: hash("token-de-outro-tipo"),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const r = await confirmarTrocaDeEmail("token-de-outro-tipo");

    expect(r.ok).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);
  });

  it("endereço com MAIÚSCULAS e espaços é normalizado", async () => {
    /**
     * Sem normalizar, a conta ficaria com o e-mail gravado em maiúsculas e o login — que busca por
     * igualdade exata — não encontraria mais a pessoa. Ela perderia o acesso justamente ao
     * consertar o endereço.
     */
    const user = await conta("normaliza");
    await pedirTrocaDeEmail(user.id, `  ${PREFIXO}-NORMALIZA-NOVO@Exemplo.Local  `, SENHA);
    await comTokenConhecido(user.id, "token-normaliza");

    await confirmarTrocaDeEmail("token-normaliza");

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(
      `${PREFIXO}-normaliza-novo@exemplo.local`,
    );
  });

  it("link expirado é recusado — com motivo PRÓPRIO, não 'inválido'", async () => {
    const user = await conta("expirado");
    // Endereço DIFERENTE do da conta: pedir o mesmo é recusado por "email_igual", e o teste
    // ficaria sem token para expirar — foi exatamente o que aconteceu na primeira versão.
    await pedirTrocaDeEmail(user.id, `${PREFIXO}-expirado-novo@exemplo.local`, SENHA);
    const registro = await comTokenConhecido(user.id, "token-expirado");
    await prisma.authToken.update({
      where: { id: registro.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const r = await confirmarTrocaDeEmail("token-expirado");

    expect(r.ok).toBe(false);
    /**
     * ⚠️ Era `link_invalido`, e a mudança é o conserto de um achado de usabilidade.
     *
     * "Inválido ou expirou" juntava numa frase duas situações com ações diferentes: link inválido é
     * erro de endereço — não há o que fazer com ele —, e expirado só pede pedir de novo. Quem lia a
     * frase misturada não sabia em qual dos dois estava, e o prazo de 1 hora (curto de propósito) não
     * era dito em lugar nenhum. Ver `tests/link-de-email-reaberto.test.ts` para os outros desfechos.
     */
    if (!r.ok) expect(r.motivo).toBe("link_expirado");
    // E a conta continua com o e-mail antigo.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);
  });

  it("⚠️ recusa se o endereço foi OCUPADO entre o pedido e o clique", async () => {
    /**
     * Cabe uma hora entre os dois, e nela alguém pode cadastrar justamente esse endereço. Sem esta
     * conferência, a aplicação estouraria com erro de banco na cara de quem clicou — e seria o
     * caminho por onde duas contas disputariam o mesmo e-mail.
     */
    const user = await conta("corrida");
    const disputado = `${PREFIXO}-disputado@exemplo.local`;
    await pedirTrocaDeEmail(user.id, disputado, SENHA);
    await comTokenConhecido(user.id, "token-corrida");
    // Outra conta nasce com o endereço no meio do caminho.
    await prisma.user.create({
      data: { email: disputado, name: "Chegou primeiro", passwordHash: "x", role: "CLIENTE", status: "ATIVO" },
    });

    const r = await confirmarTrocaDeEmail("token-corrida");

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe("email_em_uso");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);
  });

  it("invalida os links de VERIFICAÇÃO pendentes do endereço antigo", async () => {
    /**
     * Eles foram emitidos para o endereço antigo. Um deles clicado depois reconfirmaria um
     * endereço que já não é o da conta.
     */
    const user = await conta("verificacao");
    const antigo = await prisma.authToken.create({
      data: {
        userId: user.id,
        type: "VERIFICACAO_EMAIL",
        tokenHash: `${PREFIXO}-hash-verificacao`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await pedirTrocaDeEmail(user.id, `${PREFIXO}-limpa@exemplo.local`, SENHA);
    await comTokenConhecido(user.id, "token-limpa");

    await confirmarTrocaDeEmail("token-limpa");

    expect((await prisma.authToken.findUniqueOrThrow({ where: { id: antigo.id } })).usedAt).not.toBeNull();
  });

  /**
   * ⚠️ Não desfaz bloqueio administrativo. A confirmação é rota PÚBLICA.
   *
   * `status: "ATIVO"` era gravado sem olhar o atual, e isso reativava conta BLOQUEADA ou
   * SUSPENSA por um clique em e-mail — sem sessão e sem senha. Bloqueio é decisão de quem
   * administra, e voltar dele é ato de quem o aplicou; o único status que esta confirmação tem
   * autoridade para mudar é a pendência de verificação que ela própria resolve.
   */
  for (const bloqueio of ["BLOQUEADO", "SUSPENSO"] as const) {
    it(`NÃO reativa conta ${bloqueio}`, async () => {
      const user = await conta(`bloq-${bloqueio.toLowerCase()}`);
      await prisma.user.update({ where: { id: user.id }, data: { status: bloqueio } });
      await pedirTrocaDeEmail(user.id, `${PREFIXO}-${bloqueio.toLowerCase()}-novo@exemplo.local`, SENHA);
      await comTokenConhecido(user.id, `token-${bloqueio}`);

      const r = await confirmarTrocaDeEmail(`token-${bloqueio}`);

      // A troca acontece — o endereço é dele —, mas o bloqueio permanece.
      expect(r.ok).toBe(true);
      const depois = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(depois.status).toBe(bloqueio);
    });
  }

  it("conta PENDENTE_VERIFICACAO passa a ATIVO — é o que a confirmação resolve", async () => {
    const user = await conta("pendente-status");
    await prisma.user.update({
      where: { id: user.id },
      data: { status: "PENDENTE_VERIFICACAO", emailVerifiedAt: null },
    });
    await pedirTrocaDeEmail(user.id, `${PREFIXO}-pendente-novo@exemplo.local`, SENHA);
    await comTokenConhecido(user.id, "token-pendente");

    await confirmarTrocaDeEmail("token-pendente");

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("ATIVO");
  });

  it("deixa auditoria com o de→para", async () => {
    const user = await conta("auditoria");
    const novo = `${PREFIXO}-auditado@exemplo.local`;
    await pedirTrocaDeEmail(user.id, novo, SENHA);
    await comTokenConhecido(user.id, "token-auditoria");

    await confirmarTrocaDeEmail("token-auditoria");

    const registro = await prisma.auditLog.findFirstOrThrow({
      where: { action: "conta.troca_email_confirmada", entityId: user.id },
    });
    const meta = registro.metadata as Record<string, unknown>;
    expect(meta.de).toBe(user.email);
    expect(meta.para).toBe(novo);
  });
});

/**
 * ⚠️ O CAMINHO DE TOMADA DE CONTA que a revisão de segurança confirmou, e que este bloco fecha.
 *
 * O aviso enviado ao endereço antigo diz "troque sua senha agora". Enquanto trocar a senha não
 * desarmava o pedido, obedecer não protegia: o link do atacante seguia válido pela hora inteira,
 * e a confirmação é rota PÚBLICA — sem sessão e sem senha. Então:
 *
 *   atacante com a senha pede a troca → vítima recebe o aviso e OBEDECE, troca a senha →
 *   atacante clica no link → o e-mail da conta passa a ser dele → "esqueci minha senha" no
 *   endereço novo → conta e assinatura paga tomadas.
 *
 * A vítima fazia exatamente o que o produto instruiu, no prazo, e perdia a conta. Alarme que
 * orienta para ação inútil é pior que alarme nenhum: ensina a confiar no lugar errado.
 */
describe("credencial nova desarma o pedido pendente", () => {
  it("cancelar apaga o endereço pendente E mata o link", async () => {
    const user = await conta("cancela");
    await pedirTrocaDeEmail(user.id, `${PREFIXO}-cancela-novo@exemplo.local`, SENHA);
    await comTokenConhecido(user.id, "token-cancela");

    const r = await cancelarTrocaDeEmailPendente(user.id, "teste");

    expect(r.cancelou).toBe(true);
    expect(r.endereco).toBe(`${PREFIXO}-cancela-novo@exemplo.local`);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingEmail).toBeNull();

    /**
     * O link deixa de funcionar de imediato, e quem faz isso é a limpeza do `pendingEmail`: sem
     * pedido pendente, a confirmação não tem o que aplicar. É esta a barreira demonstrável — a
     * invalidação do token é redundância, e está dito assim no código.
     */
    const depoisDeCancelar = await confirmarTrocaDeEmail("token-cancela");
    expect(depoisDeCancelar.ok).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);
  });

  /**
   * O token NÃO é vinculado ao endereço para o qual foi enviado: ele aplica o que estiver
   * pendente NA HORA DO CLIQUE. Este teste trava a consequência disso — link velho não pode
   * consumir o pedido seguinte do cliente, disparando a mudança do e-mail dele na hora que um
   * terceiro escolher.
   *
   * ⚠️ HONESTIDADE SOBRE O QUE ESTE TESTE MEDE: a garantia vem de `pedirTrocaDeEmail`, que
   * invalida os pedidos anteriores antes de criar o próximo — e não do cancelamento. Desliguei a
   * invalidação do CANCELAMENTO e este teste continuou passando. Ele documenta a garantia; não
   * demonstra qual das duas invalidações a sustenta.
   */
  it("link antigo NÃO consome o pedido seguinte do cliente", async () => {
    const user = await conta("link-velho");
    await pedirTrocaDeEmail(user.id, `${PREFIXO}-do-atacante@exemplo.local`, SENHA);
    await comTokenConhecido(user.id, "token-velho");

    // A vítima cancela (é o que trocar a senha faz) e pede a troca para um endereço dela.
    await cancelarTrocaDeEmailPendente(user.id, "senha alterada pelo titular");
    await pedirTrocaDeEmail(user.id, `${PREFIXO}-escolhido-por-mim@exemplo.local`, SENHA);

    // O link VELHO não pode aplicar o pedido NOVO.
    const r = await confirmarTrocaDeEmail("token-velho");

    expect(r.ok).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);
  });

  it("cancelar sem pedido pendente não faz nada e não mente", async () => {
    const user = await conta("cancela-vazio");

    expect((await cancelarTrocaDeEmailPendente(user.id, "teste")).cancelou).toBe(false);
  });

  it("deixa auditoria do cancelamento, com o endereço que foi abandonado", async () => {
    const user = await conta("cancela-auditoria");
    await pedirTrocaDeEmail(user.id, `${PREFIXO}-abandonado@exemplo.local`, SENHA);

    await cancelarTrocaDeEmailPendente(user.id, "senha alterada pelo titular");

    const registro = await prisma.auditLog.findFirstOrThrow({
      where: { action: "conta.troca_email_cancelada", entityId: user.id },
    });
    const meta = registro.metadata as Record<string, unknown>;
    expect(meta.enderecoPretendido).toBe(`${PREFIXO}-abandonado@exemplo.local`);
    expect(meta.linksInvalidados).toBe(1);
  });
});
