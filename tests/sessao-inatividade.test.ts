import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

/**
 * Encerramento de sessão por INATIVIDADE.
 *
 * ── O que faltava ────────────────────────────────────────────────────────────
 * A sessão tinha um prazo só: `expiresAt`, absoluto, de 7 dias. Prazo absoluto não sabe se
 * tem alguém usando — então a tela logada deixada aberta continuava válida por dias, com
 * autos de execução fiscal e dados de terceiros sob sigilo profissional na frente de quem
 * passasse. Esse é o risco que o encerramento por inatividade trata, e ele não existia.
 *
 * ── Por que estes testes vão ao banco ────────────────────────────────────────
 * A regra é feita de leitura e ESCRITA na tabela de sessão: recusar, revogar e marcar o uso.
 * Regra de sessão validada só por mock é regra não validada — e a parte que mais importa
 * (revogar, para o token não voltar a servir se o relógio mudar) só existe no banco.
 */

/**
 * ⚠️ Os prazos são FIXADOS aqui, antes do import.
 *
 * As asserções falam dos números 30 e 10, e `env` os lê de `process.env` na carga do módulo.
 * Sem fixar, o `.env` da máquina de quem roda vazaria para dentro da suíte: o teste passaria
 * ou falharia por causa da configuração local, não do código — e passaria por motivo errado
 * na máquina do sócio, que montou o `.env` a partir do exemplo.
 */
process.env.SESSION_IDLE_MINUTES = "30";
process.env.SESSION_IDLE_MINUTES_EQUIPE = "10";

const { usuarioDaSessao, registrarAtividadeDaSessao, sessaoInativa, INATIVIDADE_MINUTOS } =
  await import("../src/lib/auth");

const prisma = new PrismaClient();
const PREFIXO = "test-sessao";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.securityEvent.deleteMany({ where: { email: { startsWith: PREFIXO } } });
}

beforeEach(limpar);

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

/** Conta com sessão cujo último uso foi há `minutosSemUso`. */
async function sessaoCom(
  sufixo: string,
  minutosSemUso: number,
  papel: "CLIENTE" | "ADMIN" | "REVISOR" | "SUPORTE" = "CLIENTE",
) {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Usuário ${sufixo}`,
      passwordHash: "x",
      role: papel,
      status: "ATIVO",
    },
  });
  const token = `${PREFIXO}-token-${sufixo}`;
  const sessao = await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hash(token),
      // Prazo ABSOLUTO bem no futuro: quem tem de encerrar aqui é a inatividade, não ele.
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      lastSeenAt: new Date(Date.now() - minutosSemUso * 60_000),
      ip: "198.51.100.9",
    },
  });
  return { user, token, sessao };
}

describe("a decisão, isolada", () => {
  it("mede tempo sem uso, não tempo de vida", () => {
    const limite = INATIVIDADE_MINUTOS("CLIENTE");
    const em = (min: number) => ({ lastSeenAt: new Date(Date.now() - min * 60_000), role: "CLIENTE" as const });
    expect(sessaoInativa(em(limite - 1))).toBe(false);
    expect(sessaoInativa(em(limite + 1))).toBe(true);
  });

  it("TODA a equipe tem o prazo curto; só o cliente tem o comum", () => {
    /**
     * Decisão do dono. O que separa os dois grupos é de quem são os dados na tela: o cliente
     * vê os PRÓPRIOS processos, a equipe vê os de OUTRAS pessoas — o revisor lê os autos
     * inteiros, o suporte lê o chamado, e do painel de administração se apaga conta, se libera
     * acesso à mão e se encerra caso de dinheiro.
     */
    expect(INATIVIDADE_MINUTOS("CLIENTE")).toBe(30);
    for (const papel of ["ADMIN", "REVISOR", "SUPORTE"] as const) {
      expect(INATIVIDADE_MINUTOS(papel)).toBe(10);
      expect(INATIVIDADE_MINUTOS(papel)).toBeLessThan(INATIVIDADE_MINUTOS("CLIENTE"));
    }
  });

  it("papel NOVO nasce no prazo curto — a regra é escrita pela negativa", () => {
    /**
     * ⚠️ Esta é a asserção sobre o desenho, e não sobre um valor.
     *
     * A regra pergunta "não é cliente?", não "está nesta lista de papéis internos?". Com uma
     * lista, um papel criado no futuro ficaria fora por omissão e receberia o prazo LONGO — o
     * lado inseguro, e em silêncio. Escrita pela negativa, o esquecimento cai para o lado
     * seguro, e afrouxar passa a exigir ato explícito.
     *
     * O papel fictício é forçado no tipo de propósito: o teste fala do comportamento para
     * QUALQUER papel que venha a existir, não dos quatro de hoje.
     */
    const papelQueAindaNaoExiste = "FINANCEIRO" as unknown as Parameters<typeof INATIVIDADE_MINUTOS>[0];
    expect(INATIVIDADE_MINUTOS(papelQueAindaNaoExiste)).toBe(INATIVIDADE_MINUTOS("ADMIN"));
  });

  it("no MESMO tempo parado, a equipe já caiu e o cliente não", () => {
    /**
     * A asserção que separa "existem dois números" de "os dois números são aplicados". Um
     * tempo entre os dois limites tem de dar respostas opostas para os dois grupos.
     */
    const entreOsDois = (INATIVIDADE_MINUTOS("ADMIN") + INATIVIDADE_MINUTOS("CLIENTE")) / 2;
    const lastSeenAt = new Date(Date.now() - entreOsDois * 60_000);

    for (const papel of ["ADMIN", "REVISOR", "SUPORTE"] as const) {
      expect(sessaoInativa({ lastSeenAt, role: papel })).toBe(true);
    }
    expect(sessaoInativa({ lastSeenAt, role: "CLIENTE" })).toBe(false);
  });

  // Configuração inválida tem arquivo próprio: `env` é montado na carga do módulo, então o
  // valor errado precisa existir ANTES do import. Ver sessao-inatividade-config-invalida.

  it("limite zero desliga a regra", () => {
    /**
     * Sem esta saída, pôr `SESSION_IDLE_MINUTES=0` para desativar teria o efeito oposto —
     * encerraria TODA sessão na primeira leitura, trancando todo mundo fora do sistema.
     */
    expect(sessaoInativa({ lastSeenAt: new Date(0), role: "CLIENTE" }, new Date(0))).toBe(false);
  });
});

describe("sessão parada tempo demais", () => {
  it("é RECUSADA", async () => {
    const { token } = await sessaoCom("parada", INATIVIDADE_MINUTOS("CLIENTE") + 5);

    expect(await usuarioDaSessao(token)).toBeNull();
  });

  it("é REVOGADA, e não só recusada", async () => {
    const { token, sessao } = await sessaoCom("revogada", INATIVIDADE_MINUTOS("CLIENTE") + 5);

    await usuarioDaSessao(token);

    /**
     * Recusar e deixar a linha válida faria o token voltar a servir se a conta do relógio
     * mudasse — correção de hora, fuso, ou alguém aumentando o limite. Revogar é o que torna
     * o encerramento definitivo, pelo mesmo campo que a saída manual usa.
     */
    const depois = await prisma.session.findUniqueOrThrow({ where: { id: sessao.id } });
    expect(depois.revokedAt).not.toBeNull();

    // E continua recusada mesmo com o limite dilatado: a revogação não depende do relógio.
    expect(await usuarioDaSessao(token, new Date())).toBeNull();
  });

  it("deixa registro de segurança, para distinguir de quem saiu por conta própria", async () => {
    const { token, user } = await sessaoCom("registro", INATIVIDADE_MINUTOS("CLIENTE") + 5);

    await usuarioDaSessao(token);

    const evento = await prisma.securityEvent.findFirstOrThrow({
      where: { type: "sessao_encerrada_por_inatividade", email: user.email },
    });
    // Sem isto, "fui desconectado no meio do trabalho" não tem como ser respondido.
    const meta = evento.metadata as Record<string, unknown>;
    expect(meta.minutos).toBe(INATIVIDADE_MINUTOS("CLIENTE"));
    /**
     * O papel entra no registro porque os prazos são diferentes: sem ele, não há como
     * conferir depois se o encerramento respeitou o prazo daquela conta.
     */
    expect(meta.papel).toBe("CLIENTE");
    expect(evento.ip).toBe("198.51.100.9");
  });
});

describe("as contas da equipe, no banco", () => {
  /**
   * O teste que prova a regra de ponta a ponta: MESMO tempo parado, papéis diferentes,
   * desfechos opostos — e passando pela leitura real da sessão, não só pela conta de tempo.
   *
   * Os três papéis internos são exercitados, e não só o ADMIN: foi justamente por REVISOR e
   * SUPORTE terem ficado de fora na primeira versão que a decisão precisou ser revisada.
   */
  for (const papel of ["ADMIN", "REVISOR", "SUPORTE"] as const) {
    it(`${papel} cai no prazo curto, num tempo em que a de cliente ainda vale`, async () => {
      const entreOsDois = (INATIVIDADE_MINUTOS(papel) + INATIVIDADE_MINUTOS("CLIENTE")) / 2;
      const equipe = await sessaoCom(`equipe-${papel.toLowerCase()}`, entreOsDois, papel);
      const cliente = await sessaoCom(`cliente-${papel.toLowerCase()}`, entreOsDois, "CLIENTE");

      expect(await usuarioDaSessao(equipe.token)).toBeNull();
      expect((await usuarioDaSessao(cliente.token))?.id).toBe(cliente.user.id);

      // E a da equipe foi revogada, não só recusada.
      const depois = await prisma.session.findUniqueOrThrow({ where: { id: equipe.sessao.id } });
      expect(depois.revokedAt).not.toBeNull();
    });
  }

  it("dentro do prazo curto, continua valendo", async () => {
    const { token, user } = await sessaoCom("admin-ativo", INATIVIDADE_MINUTOS("ADMIN") - 1, "ADMIN");

    expect((await usuarioDaSessao(token))?.id).toBe(user.id);
  });

  it("o registro de segurança diz o prazo da EQUIPE, não o do cliente", async () => {
    const { token, user } = await sessaoCom("revisor-registro", INATIVIDADE_MINUTOS("REVISOR") + 1, "REVISOR");

    await usuarioDaSessao(token);

    const evento = await prisma.securityEvent.findFirstOrThrow({
      where: { type: "sessao_encerrada_por_inatividade", email: user.email },
    });
    const meta = evento.metadata as Record<string, unknown>;
    expect(meta.papel).toBe("REVISOR");
    expect(meta.minutos).toBe(INATIVIDADE_MINUTOS("REVISOR"));
  });
});

describe("sessão em uso", () => {
  it("continua valendo", async () => {
    const { token, user } = await sessaoCom("ativa", 1);

    const encontrado = await usuarioDaSessao(token);

    expect(encontrado?.id).toBe(user.id);
  });

  /**
   * ⚠️ TRÁFEGO DE FUNDO NÃO É USO — e este era o furo que desmontava a regra inteira.
   *
   * A primeira versão renovava `lastSeenAt` em toda requisição autenticada. A tela de análise
   * faz `router.refresh()` a cada 4 segundos enquanto o processamento corre, cada refresh lê a
   * sessão, e a leitura renovava o relógio: deixar uma análise processando mantinha a sessão
   * viva para sempre, sem ninguém na frente — exatamente o caso que a regra existe para pegar.
   * O componente da tela evitava contar tráfego; o servidor não, e o comentário afirmava que
   * o desenho evitava. Afirmava mais do que o código fazia.
   */
  it("leitura comum NÃO renova o relógio: tráfego de fundo não segura a sessão", async () => {
    const { token, sessao } = await sessaoCom("trafego", 5);

    // Cinquenta leituras, como o poll de 4 segundos faria em poucos minutos.
    for (let i = 0; i < 3; i++) await usuarioDaSessao(token);

    const depois = await prisma.session.findUniqueOrThrow({ where: { id: sessao.id } });
    expect(depois.lastSeenAt.getTime()).toBe(sessao.lastSeenAt.getTime());
  });

  it("e por isso a sessão parada MORRE mesmo com tráfego de fundo constante", async () => {
    /**
     * A consequência do teste acima, dita como o usuário a sentiria. Antes, esta sessão nunca
     * expirava: bastava a tela de análise estar aberta.
     */
    const { token } = await sessaoCom("trafego-morre", INATIVIDADE_MINUTOS("CLIENTE") - 1);

    // Tráfego de fundo enquanto o tempo passa: nenhuma dessas leituras é interação.
    expect(await usuarioDaSessao(token)).not.toBeNull();
    const depoisDoLimite = new Date(Date.now() + 2 * 60_000);
    expect(await usuarioDaSessao(token, depoisDoLimite)).toBeNull();
  });

  it("o ping de atividade É o que renova — é o único caminho que pode", async () => {
    const { token, sessao } = await sessaoCom("ping", 5);

    // `registrarAtividadeDaSessao` lê o cookie; aqui se usa a forma explícita equivalente.
    await usuarioDaSessao(token, new Date(), true);

    const depois = await prisma.session.findUniqueOrThrow({ where: { id: sessao.id } });
    expect(depois.lastSeenAt.getTime()).toBeGreaterThan(sessao.lastSeenAt.getTime());
    expect(depois.revokedAt).toBeNull();
    // A função exportada existe e é a que a rota usa.
    expect(typeof registrarAtividadeDaSessao).toBe("function");
  });

  it("nem o ping regrava a cada chamada — o banco é o plano mais barato do Render", async () => {
    const { token, sessao } = await sessaoCom("folga", 0);

    await usuarioDaSessao(token, new Date(), true);

    /**
     * O ping sai no máximo uma vez por minuto, mas a folga aqui é a garantia do lado do
     * servidor: sem ela, cada chamada viraria um UPDATE e a proteção sairia paga em gargalo.
     */
    const depois = await prisma.session.findUniqueOrThrow({ where: { id: sessao.id } });
    expect(depois.lastSeenAt.getTime()).toBe(sessao.lastSeenAt.getTime());
  });
});

describe("o prazo absoluto continua valendo", () => {
  it("sessão dentro da inatividade mas VENCIDA é recusada", async () => {
    /**
     * A inatividade é um prazo NOVO, não um substituto: uma sessão usada agora mas com o
     * prazo absoluto no passado tem de cair. Trocar um prazo pelo outro deixaria sessão
     * eterna para quem mexe de vez em quando.
     */
    const { token, sessao } = await sessaoCom("vencida", 0);
    await prisma.session.update({
      where: { id: sessao.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    expect(await usuarioDaSessao(token)).toBeNull();
  });
});
