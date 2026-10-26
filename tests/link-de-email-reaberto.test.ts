import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

/**
 * Reabrir um link de e-mail que já foi usado.
 *
 * ── O achado, e por que ele custa venda ───────────────────────────────────────
 * Todo token já usado caía numa frase só: "link inválido ou expirou". Inclusive — e principalmente
 * — o caso mais comum de todos: a pessoa clica, DÁ CERTO, e volta ao link. Recarregando a aba,
 * clicando de novo no e-mail, ou sem fazer nada, porque há cliente de e-mail que pré-abre links para
 * montar a pré-visualização.
 *
 * O que ela lia era "inválido", logo depois de ter funcionado. As duas leituras possíveis são ruins:
 *
 *  - na confirmação de CADASTRO: ela conclui que a conta não está confirmada. E confirmar é
 *    pré-requisito para contratar — então ela para de tentar comprar por causa de uma mensagem de
 *    erro sobre algo que deu certo.
 *  - na TROCA de e-mail: ela pede a troca de novo, gastando o limite de cinco em quinze minutos e
 *    deixando um `pendingEmail` novo numa conta que já estava correta.
 *
 * ── Por que os desfechos são separados ────────────────────────────────────────
 * `usedAt` é gravado por três caminhos: a confirmação, o cancelamento (que é o que trocar a senha
 * faz) e o pedido seguinte, que invalida o anterior. O campo sozinho não distingue, e cada um pede
 * uma ação diferente de quem lê. Os testes abaixo travam os três, mais o expirado — que a versão
 * anterior misturava com "inválido" na mesma frase.
 */

process.env.EMAIL_DRIVER = "console";

const { pedirTrocaDeEmail, confirmarTrocaDeEmail, cancelarTrocaDeEmailPendente } =
  await import("../src/lib/troca-de-email");
const { emitirVerificacaoDeEmail } = await import("../src/lib/verificacao-email");
const { hashPassword } = await import("../src/lib/password");
const { POST: CONFIRMAR_TROCA } = await import("../src/app/api/conta/email/confirmar/route");
const { POST: VERIFICAR_CADASTRO } = await import("../src/app/api/auth/verificar-email/route");

const prisma = new PrismaClient();
const PREFIXO = "test-reaberto";
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

async function conta(sufixo: string, opcoes: { verificado?: boolean } = {}) {
  return prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Pessoa ${sufixo}`,
      passwordHash: await hashPassword(SENHA),
      role: "CLIENTE",
      status: opcoes.verificado === false ? "PENDENTE_VERIFICACAO" : "ATIVO",
      emailVerifiedAt: opcoes.verificado === false ? null : new Date(),
    },
  });
}

const destino = (s: string) => `${PREFIXO}-${s}-novo@exemplo.local`;

/** Troca o hash do último token vivo por um conhecido, para o teste poder "clicar" no link. */
async function comTokenConhecido(userId: string, tipo: "TROCA_EMAIL" | "VERIFICACAO_EMAIL", emClaro: string) {
  const registro = await prisma.authToken.findFirstOrThrow({
    where: { userId, type: tipo, usedAt: null },
    orderBy: { createdAt: "desc" },
  });
  await prisma.authToken.update({ where: { id: registro.id }, data: { tokenHash: hash(emClaro) } });
  return registro;
}

/**
 * O IP é diferente em cada chamada de propósito: o limite da rota de confirmação é por IP (20 em 10
 * minutos) e o balde vive em memória do processo. Com todos os testes no mesmo IP, os últimos do
 * arquivo começariam a receber 429 — falha por vizinhança, o pior tipo de teste frágil.
 */
function pedidoDeConfirmacao(token: string, ip: string) {
  return new Request("http://localhost/api/conta/email/confirmar", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-real-ip": ip },
    body: JSON.stringify({ token }),
  }) as never;
}

function pedidoDeVerificacao(token: string) {
  return new Request("http://localhost/api/auth/verificar-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }) as never;
}

describe("troca de e-mail: o link que JÁ DEU CERTO", () => {
  it("⚠️ diz que já valeu, e diz para qual endereço — não 'inválido'", async () => {
    const user = await conta("valeu");
    const novo = destino("valeu");
    await pedirTrocaDeEmail(user.id, novo, SENHA);
    await comTokenConhecido(user.id, "TROCA_EMAIL", "tok-valeu");
    expect((await confirmarTrocaDeEmail("tok-valeu")).ok).toBe(true);

    const segunda = await confirmarTrocaDeEmail("tok-valeu");

    expect(segunda.ok).toBe(false);
    if (!segunda.ok) {
      expect(segunda.motivo).toBe("ja_confirmado");
      /**
       * O endereço vem da AUDITORIA, não de `user.email`: é o que ESTE link aplicou. Se a conta
       * trocasse de endereço mais uma vez depois, `user.email` seria um terceiro endereço — e a tela
       * o revelaria a quem só teve acesso ao segundo.
       */
      expect(segunda.aplicado).toBe(novo);
    }
  });

  it("⚠️ a rota responde 200, e a mensagem NÃO fala de link inválido", async () => {
    /**
     * A asserção que fecha o achado. Enquanto a resposta era 400 com "inválido ou expirou", a tela
     * pintava de vermelho um sucesso — e quem leu isso foi pedir outra troca.
     */
    const user = await conta("rota-200");
    const novo = destino("rota-200");
    await pedirTrocaDeEmail(user.id, novo, SENHA);
    await comTokenConhecido(user.id, "TROCA_EMAIL", "tok-rota-200");
    expect((await CONFIRMAR_TROCA(pedidoDeConfirmacao("tok-rota-200", "10.1.0.1"))).status).toBe(200);

    const res = await CONFIRMAR_TROCA(pedidoDeConfirmacao("tok-rota-200", "10.1.0.2"));
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.ok).toBe(true);
    expect(corpo.data.jaEstavaFeita).toBe(true);
    expect(corpo.data.message).toContain(novo);
    expect(corpo.data.message.toLowerCase()).not.toContain("inválido");
    expect(corpo.data.message.toLowerCase()).not.toContain("expirou");
  });

  it("e a conta NÃO é mexida de novo pelo segundo clique", async () => {
    // O caminho é de leitura pura. Se ele reaplicasse algo, o segundo clique mexeria numa conta certa.
    const user = await conta("nao-mexe");
    const novo = destino("nao-mexe");
    await pedirTrocaDeEmail(user.id, novo, SENHA);
    await comTokenConhecido(user.id, "TROCA_EMAIL", "tok-nao-mexe");
    await confirmarTrocaDeEmail("tok-nao-mexe");
    const depoisDaPrimeira = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    await confirmarTrocaDeEmail("tok-nao-mexe");

    const depoisDaSegunda = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(depoisDaSegunda.email).toBe(novo);
    expect(depoisDaSegunda.pendingEmail).toBeNull();
    expect(depoisDaSegunda.emailVerifiedAt?.getTime()).toBe(depoisDaPrimeira.emailVerifiedAt?.getTime());
  });
});

describe("troca de e-mail: os outros desfechos do link já usado", () => {
  it("⚠️ link substituído NÃO revela o endereço pendente — rota pública", async () => {
    /**
     * ⚠️ ESTE TESTE INVERTEU. A primeira versão afirmava `r.pendente === destino("segundo")`, com o
     * comentário "sem dizer o endereço, a pessoa não sabe QUAL dos dois e-mails da caixa abrir". A
     * revisão de segurança derrubou o raciocínio: ele supõe a MESMA caixa nos dois pedidos, e isso é
     * falso exatamente no caso que a troca de e-mail existe para resolver.
     *
     *   O cliente digita errado (joao@exemplo.co) e o link vai para a caixa de um TERCEIRO. Ele
     *   percebe e pede de novo para joao@exemplo.com.br. O terceiro abre o link que recebeu — a rota é
     *   PÚBLICA, sem sessão e sem senha — e lia o endereço real do cliente, que vira o login da conta
     *   assim que o titular confirmar.
     *
     * Dado pessoal de cliente entregue a um estranho, mais a indicação de qual caixa atacar. E sem
     * prazo: "já usado" é conferido antes de "expirado", então o link morto responderia para sempre.
     */
    const user = await conta("substituido");
    await pedirTrocaDeEmail(user.id, destino("primeiro"), SENHA);
    await comTokenConhecido(user.id, "TROCA_EMAIL", "tok-primeiro");
    await pedirTrocaDeEmail(user.id, destino("segundo"), SENHA);

    const r = await confirmarTrocaDeEmail("tok-primeiro");

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe("link_substituido");
    // Nem no retorno da função, nem na mensagem que chega ao navegador.
    expect(JSON.stringify(r)).not.toContain(destino("segundo"));
    const corpo = await (await CONFIRMAR_TROCA(pedidoDeConfirmacao("tok-primeiro", "10.1.0.9"))).json();
    expect(corpo.error).not.toContain(destino("segundo"));
    // A orientação continua útil sem nomear ninguém: abra o mais recente.
    expect(corpo.error).toContain("mais recente");
  });

  it("link cancelado não é confundido com link que deu certo", async () => {
    /**
     * O cancelamento é o que trocar a senha faz — e é o caminho da vítima de tentativa de tomada de
     * conta. Dizer a ela "já deu certo" seria dizer que o atacante conseguiu.
     */
    const user = await conta("cancelado");
    await pedirTrocaDeEmail(user.id, destino("cancelado"), SENHA);
    await comTokenConhecido(user.id, "TROCA_EMAIL", "tok-cancelado");
    await cancelarTrocaDeEmailPendente(user.id, "senha alterada pelo titular");

    const r = await confirmarTrocaDeEmail("tok-cancelado");

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe("link_encerrado");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);

    /**
     * A mensagem cita as TRÊS hipóteses e começa pela de que deu certo. Este ramo é o que sobra quando
     * nada identifica o link — o que inclui uma troca que FUNCIONOU e cuja auditoria não saiu
     * (`logAudit` engole o próprio erro). Abrir com "foi cancelado" seria anunciar fracasso na
     * hipótese errada, que é o defeito que este conserto existe para fechar.
     */
    const corpo = await (await CONFIRMAR_TROCA(pedidoDeConfirmacao("tok-cancelado", "10.1.0.8"))).json();
    expect(corpo.error).toContain("já ter sido aplicada");
    expect(corpo.error).toContain("cancelado");
  });

  it("⚠️ sem a auditoria, o estado da conta AINDA diz que o link deu certo", async () => {
    /**
     * A rede de segurança do conserto principal. `logAudit` é best-effort: engole o erro e só imprime
     * no console. Se a escrita cair, o `linkId` não existe — e a versão anterior mandava a troca
     * CONCLUÍDA para "link_encerrado", ou seja, anunciava fracasso depois do sucesso, exatamente o que
     * este commit veio consertar.
     *
     * A rede compara `emailVerifiedAt` com o `usedAt` do token: os dois são gravados na MESMA transação,
     * pelo `new Date()` do MESMO processo. Aqui a auditoria é apagada para simular a falha.
     */
    const user = await conta("sem-auditoria");
    const novo = destino("sem-auditoria");
    await pedirTrocaDeEmail(user.id, novo, SENHA);
    await comTokenConhecido(user.id, "TROCA_EMAIL", "tok-sem-auditoria");
    expect((await confirmarTrocaDeEmail("tok-sem-auditoria")).ok).toBe(true);

    await prisma.auditLog.deleteMany({ where: { action: "conta.troca_email_confirmada", entityId: user.id } });

    const r = await confirmarTrocaDeEmail("tok-sem-auditoria");

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.motivo).toBe("ja_confirmado");
      // Sem a auditoria não se sabe QUAL endereço foi aplicado — perde-se o detalhe, não a verdade.
      expect(r.aplicado).toBeNull();
    }
    const corpo = await (await CONFIRMAR_TROCA(pedidoDeConfirmacao("tok-sem-auditoria", "10.1.0.7"))).json();
    expect(corpo.ok).toBe(true);
    expect(corpo.data.jaEstavaFeita).toBe(true);
  });

  it("⚠️ expirado é um motivo PRÓPRIO, e a mensagem diz o prazo", async () => {
    /**
     * "Inválido ou expirou" juntava duas coisas com ações diferentes: link inválido é erro de
     * endereço; expirado é só pedir de novo. E o prazo de 1 hora é curto de propósito — quem não
     * sabe disso acha que o sistema falhou.
     */
    const user = await conta("expirou");
    await pedirTrocaDeEmail(user.id, destino("expirou"), SENHA);
    const registro = await comTokenConhecido(user.id, "TROCA_EMAIL", "tok-expirou");
    await prisma.authToken.update({
      where: { id: registro.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const r = await confirmarTrocaDeEmail("tok-expirou");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe("link_expirado");

    const corpo = await (await CONFIRMAR_TROCA(pedidoDeConfirmacao("tok-expirou", "10.1.0.3"))).json();
    expect(corpo.error).toContain("1 hora");
    expect(corpo.reason).toBe("link_expirado");
  });

  it("token de OUTRO tipo já usado não recebe explicação de troca", async () => {
    /**
     * A explicação do "já usado" só vale para token de troca. Um link de recuperação de senha já
     * consumido não pode render informação sobre pedidos de troca desta conta — nem por engano, nem
     * como pista.
     */
    const user = await conta("outro-tipo");
    await prisma.authToken.create({
      data: {
        userId: user.id,
        type: "RECUPERACAO_SENHA",
        tokenHash: hash("tok-outro-tipo"),
        expiresAt: new Date(Date.now() + 3_600_000),
        usedAt: new Date(),
      },
    });

    const r = await confirmarTrocaDeEmail("tok-outro-tipo");

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe("link_invalido");
  });
});

describe("confirmação de cadastro: o link reaberto", () => {
  it("⚠️ segundo clique responde 200 dizendo que já está confirmado", async () => {
    const user = await conta("cadastro-ok", { verificado: false });
    await emitirVerificacaoDeEmail(user);
    await comTokenConhecido(user.id, "VERIFICACAO_EMAIL", "tok-cadastro-ok");
    expect((await VERIFICAR_CADASTRO(pedidoDeVerificacao("tok-cadastro-ok"))).status).toBe(200);

    const res = await VERIFICAR_CADASTRO(pedidoDeVerificacao("tok-cadastro-ok"));
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.jaConfirmado).toBe(true);
    expect(corpo.data.message.toLowerCase()).not.toContain("inválido");
    /**
     * ⚠️ E NÃO repete o endereço. A conta pode ter trocado de e-mail depois; quem guardou este link é
     * quem tinha acesso à caixa ANTIGA, e dizer o endereço atual entregaria a ela o endereço novo.
     */
    expect(corpo.data.message).not.toContain(user.email);
  });

  it("link substituído por um reenvio manda abrir o e-mail mais recente", async () => {
    /**
     * O reenvio invalida o anterior de propósito (o link antigo pode ter ido para a caixa de um
     * terceiro). Quem tem dois e-mails na caixa e abre o primeiro precisa ler isso, não "inválido".
     */
    const user = await conta("cadastro-sub", { verificado: false });
    await emitirVerificacaoDeEmail(user);
    await comTokenConhecido(user.id, "VERIFICACAO_EMAIL", "tok-antigo");
    await emitirVerificacaoDeEmail(user);

    const corpo = await (await VERIFICAR_CADASTRO(pedidoDeVerificacao("tok-antigo"))).json();

    expect(corpo.ok).toBe(false);
    expect(corpo.error).toContain("mais recente");
    // E não atribui à expiração, que mandaria a pessoa esperar em vez de abrir o outro e-mail.
    expect(corpo.error).not.toContain("expirou");
  });

  it("expirado aponta o botão que resolve", async () => {
    const user = await conta("cadastro-exp", { verificado: false });
    await emitirVerificacaoDeEmail(user);
    const registro = await comTokenConhecido(user.id, "VERIFICACAO_EMAIL", "tok-expirado-cadastro");
    await prisma.authToken.update({
      where: { id: registro.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const corpo = await (await VERIFICAR_CADASTRO(pedidoDeVerificacao("tok-expirado-cadastro"))).json();

    expect(corpo.ok).toBe(false);
    // Diz o prazo e diz o nome do botão, que é o único caminho dentro do produto.
    expect(corpo.error).toContain("2 dias");
    expect(corpo.error).toContain("Reenviar");
  });
});

describe("o reenvio avisa que matou o link anterior", () => {
  it("primeira emissão não avisa nada — não havia link para matar", async () => {
    const user = await conta("primeira", { verificado: false });

    expect((await emitirVerificacaoDeEmail(user)).substituiuAnteriores).toBe(false);
  });

  it("⚠️ a segunda avisa, e é esse aviso que evita o clique no e-mail antigo", async () => {
    /**
     * Sem este sinal, a tela não tem como dizer "o link anterior deixou de valer" — e a pessoa fica
     * com dois e-mails iguais na caixa sem saber que só o último funciona. A busca por "Prescrição"
     * acha o antigo primeiro.
     */
    const user = await conta("segunda", { verificado: false });
    await emitirVerificacaoDeEmail(user);

    expect((await emitirVerificacaoDeEmail(user)).substituiuAnteriores).toBe(true);
  });

  it("⚠️ link já VENCIDO não conta como substituído — senão o aviso mentiria", async () => {
    /**
     * Quem tinha apenas um link expirado há dias não perdeu nada AGORA. Dizer "o link anterior deixou
     * de valer" sugeriria que acabamos de derrubar algo, e mandaria a pessoa caçar na caixa um e-mail
     * que já não servia — com a sensação de ter perdido a janela por pouco.
     *
     * O link vencido continua sendo invalidado; só não entra na contagem que gera o aviso.
     */
    const user = await conta("vencido", { verificado: false });
    await emitirVerificacaoDeEmail(user);
    await prisma.authToken.updateMany({
      where: { userId: user.id, type: "VERIFICACAO_EMAIL" },
      data: { expiresAt: new Date(Date.now() - 86_400_000) },
    });

    expect((await emitirVerificacaoDeEmail(user)).substituiuAnteriores).toBe(false);
    // E o vencido foi marcado como usado de todo jeito: um só link vivo fica de pé.
    expect(
      await prisma.authToken.count({ where: { userId: user.id, type: "VERIFICACAO_EMAIL", usedAt: null } }),
    ).toBe(1);
  });
});
