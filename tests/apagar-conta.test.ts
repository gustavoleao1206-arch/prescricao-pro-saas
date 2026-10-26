import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { inventarioDaConta, apagarConta } from "../src/lib/apagar-conta";
import { putObject, getObject } from "../src/lib/storage";

/**
 * Exclusão de conta.
 *
 * Existe porque a operação é IRREVERSÍVEL e roda contra o banco de PRODUÇÃO. Duas
 * coisas precisam estar provadas antes de alguém digitar o comando lá:
 *
 * 1. A ordem das chaves estrangeiras. `Analysis.ownerId` é obrigatório e aponta
 *    para User: apagar a pessoa antes da organização é recusado pelo banco no meio
 *    do caminho, deixando a conta pela metade. O teste cria justamente uma análise
 *    para que a ordem errada falhe aqui, e não em produção.
 *
 * 2. As travas. Não apagar ADMIN (o dono se trancaria fora do sistema) e não
 *    apagar quem tem pagamento aprovado sem insistir (é cliente real, e o registro
 *    da venda tem de ser guardado).
 *
 * Vai ao banco de verdade: é a cascata do Postgres que está sendo verificada, e
 * cascata não existe em mock.
 */

const prisma = new PrismaClient();
const PREFIXO = "test-apagar";

let planoId = "";

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orgs = await prisma.organization.findMany({
    where: { OR: [{ name: { startsWith: PREFIXO } }, { ownerId: { in: ids } }] },
    select: { id: true },
  });
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
  // Pagamento sobrevive à exclusão da assinatura (subscriptionId vira NULL), então
  // a limpeza tem de ser pelo externalId — senão sobra órfão entre execuções.
  await prisma.payment.deleteMany({ where: { externalId: { startsWith: PREFIXO } } });
  await prisma.securityEvent.deleteMany({ where: { email: { startsWith: PREFIXO } } });
  /**
   * ⚠️ O rastro PSEUDONIMIZADO não é alcançado pelo laço acima.
   *
   * Depois da exclusão a linha não tem mais o e-mail do teste: tem o código da conta. A
   * limpeza por prefixo de e-mail passa longe dela, e ela sobreviveria entre execuções — o
   * teste que conta "duas tentativas falhas" veria quatro na segunda rodada. É a mesma
   * armadilha de sempre: passa isolado e falha em sequência, ou pior, passa nas duas medindo
   * a rodada anterior.
   */
  await prisma.securityEvent.deleteMany({ where: { email: { startsWith: "conta-apagada:" } } });
  await prisma.auditLog.deleteMany({
    where: { action: "conta.apagada", metadata: { path: ["email"], string_starts_with: PREFIXO } },
  });
  await prisma.plan.deleteMany({ where: { slug: { startsWith: PREFIXO } } });
}

/** Monta uma conta completa: organização, assinatura, pagamento, razão e análise. */
async function contaCompleta(
  sufixo: string,
  opcoes: { perfil?: "CLIENTE" | "ADMIN"; statusPagamento?: "APROVADO" | "PENDENTE" | "RECUSADO" } = {},
) {
  const email = `${PREFIXO}-${sufixo}@exemplo.local`;
  const externalIdPagamento = `${PREFIXO}-${sufixo}-pay`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Conta ${sufixo}`,
      role: opcoes.perfil ?? "CLIENTE",
      status: "ATIVO",
      emailVerifiedAt: new Date(),
    },
  });
  const org = await prisma.organization.create({ data: { name: `${PREFIXO}-${sufixo}`, ownerId: user.id } });
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id, orgRole: "OWNER" } });

  const sub = await prisma.subscription.create({
    data: {
      organizationId: org.id,
      planId: planoId,
      status: "ATIVA",
      provider: "ASAAS",
      amountCents: 11990,
      analysesQuota: 8,
    },
  });
  await prisma.payment.create({
    data: {
      subscriptionId: sub.id,
      provider: "ASAAS",
      /**
       * RECUSADO é o padrão, e a troca não é cosmética.
       *
       * O padrão era PENDENTE, escolhido quando esse status não significava nada em
       * particular — era só "não aprovado". Hoje `Payment` PENDENTE quer dizer uma coisa
       * só: dinheiro que entrou, não virou serviço e TEM DE SER DEVOLVIDO. Por isso a
       * exclusão de conta passou a recusar quando existe um (apagar a conta apaga quem é
       * o credor). Estes testes falam de outra coisa — a cascata — e precisam de um
       * pagamento inócuo: RECUSADO é cobrança que falhou, nenhum dinheiro entrou.
       */
      status: opcoes.statusPagamento ?? "RECUSADO",
      amountCents: 11990,
      externalId: externalIdPagamento,
      /**
       * Payload cru do provedor, COM dado pessoal dentro, para o teste de limpeza do campo
       * medir algo. Sem isto, a asserção `raw === null` passaria por vacuidade — o código
       * atual nunca preenche esse campo, e o teste diria "limpo" sobre o que já era vazio.
       */
      raw: { customer: { name: `Conta ${sufixo}`, email, cpfCnpj: "52998224725" } },
    },
  });
  await prisma.creditLedger.create({
    data: {
      subscriptionId: sub.id,
      kind: "ASSINATURA",
      bucket: "MENSAL",
      quantity: 8,
      balanceBefore: 0,
      balanceAfter: 8,
      description: "Créditos do ciclo",
      idempotencyKey: `${PREFIXO}-${sufixo}-ciclo`,
    },
  });

  // A análise é o ponto que quebra se a ordem de exclusão estiver errada.
  const analise = await prisma.analysis.create({
    data: { organizationId: org.id, ownerId: user.id, title: `Análise ${sufixo}` },
  });

  /**
   * Documento COM ARQUIVO DE VERDADE no armazenamento.
   *
   * É o que permite provar a eliminação do dado mais sensível do sistema. Sem um
   * objeto real gravado, o teste passaria mesmo se `apagarConta` ignorasse o
   * armazenamento — foi exatamente o que acontecia antes.
   */
  const arquivo = await putObject(`${PREFIXO}/${sufixo}`, "processo.pdf", Buffer.from("conteudo de teste"));
  await prisma.document.create({
    data: {
      organizationId: org.id,
      analysisId: analise.id,
      filename: "processo.pdf",
      mimeType: "application/pdf",
      sizeBytes: 17,
      storageKey: arquivo.key,
    },
  });

  await prisma.consent.create({
    data: { userId: user.id, type: "TERMOS_USO", version: "1.0" },
  });
  await prisma.authToken.create({
    data: { userId: user.id, type: "CRIACAO_SENHA", tokenHash: `${PREFIXO}-${sufixo}-hash`, expiresAt: new Date(Date.now() + 86_400_000) },
  });

  return { email, userId: user.id, orgId: org.id, subId: sub.id, analiseId: analise.id, externalIdPagamento, storageKey: arquivo.key };
}

beforeAll(async () => {
  await limpar();
  const plano = await prisma.plan.create({
    data: {
      slug: `${PREFIXO}-plano`,
      name: "Plano Apagar",
      priceCents: 11990,
      period: "MENSAL",
      monthlyAnalyses: 8,
      maxUsers: 1,
    },
  });
  planoId = plano.id;
});

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

beforeEach(async () => {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orgs = await prisma.organization.findMany({ where: { ownerId: { in: ids } }, select: { id: true } });
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

describe("inventário antes de apagar", () => {
  it("conta tudo que depende da conta, sem alterar nada", async () => {
    const c = await contaCompleta("inv");

    const inv = await inventarioDaConta(c.email);
    expect(inv).toBeTruthy();
    expect(inv!.userId).toBe(c.userId);
    expect(inv!.organizacoes).toHaveLength(1);
    expect(inv!.assinaturas).toHaveLength(1);
    expect(inv!.pagamentos).toBe(1);
    expect(inv!.pagamentosAprovados).toBe(0);
    expect(inv!.lancamentosDeCredito).toBe(1);
    expect(inv!.analises).toBe(1);
    expect(inv!.consentimentos).toBe(1);
    expect(inv!.tokens).toBe(1);

    // Consultar não apaga.
    expect(await prisma.user.findUnique({ where: { id: c.userId } })).toBeTruthy();
  });

  it("devolve nulo para e-mail que não existe", async () => {
    expect(await inventarioDaConta(`${PREFIXO}-fantasma@exemplo.local`)).toBeNull();
  });

  it("aceita e-mail com diferença de maiúsculas e espaços", async () => {
    const c = await contaCompleta("caixa");
    const inv = await inventarioDaConta(`  ${c.email.toUpperCase()}  `);
    expect(inv?.userId).toBe(c.userId);
  });
});

describe("exclusão", () => {
  it("apaga a conta e tudo em cascata, na ordem correta", async () => {
    const c = await contaCompleta("ok");

    const r = await apagarConta(c.email);
    expect(r.apagado).toBe(true);

    // Nada deve sobrar em nenhuma das tabelas dependentes.
    expect(await prisma.user.findUnique({ where: { id: c.userId } })).toBeNull();
    expect(await prisma.organization.findUnique({ where: { id: c.orgId } })).toBeNull();
    expect(await prisma.subscription.findUnique({ where: { id: c.subId } })).toBeNull();
    expect(await prisma.analysis.findUnique({ where: { id: c.analiseId } })).toBeNull();
    /**
     * ⚠️ O pagamento SOBREVIVE, desligado da assinatura — e a asserção mudou por decisão.
     *
     * Antes se exigia que a linha desaparecesse. Ela agora é preservada sem dono: guarda
     * valor, forma de pagamento e id da cobrança no provedor, nenhum dado pessoal. É o
     * registro contábil que a obrigação fiscal manda guardar, e é também o que impede a
     * reconciliação de "redescobrir" esse pagamento no Asaas e abrir um caso falso de
     * dinheiro sem destino a cada varredura.
     *
     * A verificação é pelo `externalId`, e não por `subscriptionId`: a coluna virou NULL,
     * então contar por ela daria zero de qualquer jeito — o teste passaria sem provar nada.
     */
    const pagamento = await prisma.payment.findFirstOrThrow({
      where: { externalId: c.externalIdPagamento },
    });
    expect(pagamento.subscriptionId).toBeNull();
    // O valor tem de continuar legível: registro de dinheiro sem o valor não serve de nada.
    expect(pagamento.amountCents).toBe(11990);
    expect(await prisma.creditLedger.count({ where: { subscriptionId: c.subId } })).toBe(0);
    expect(await prisma.consent.count({ where: { userId: c.userId } })).toBe(0);
    expect(await prisma.authToken.count({ where: { userId: c.userId } })).toBe(0);
    expect(await prisma.document.count({ where: { organizationId: c.orgId } })).toBe(0);
  });

  it("APAGA O ARQUIVO no armazenamento, não só a linha do banco", async () => {
    const c = await contaCompleta("arquivo");
    // Sanidade: o objeto existe antes.
    await expect(getObject(c.storageKey)).resolves.toBeInstanceOf(Buffer);

    const r = await apagarConta(c.email);
    expect(r.apagado).toBe(true);
    expect(r.arquivosRemovidos).toBe(1);
    expect(r.arquivosComFalha).toEqual([]);

    /**
     * Este é o ponto do teste.
     *
     * A cascata apaga a linha `Document` — e com ela a `storageKey`. Se a exclusão
     * não removesse o objeto ANTES, a cópia do processo continuaria guardada sem
     * nenhum registro dizendo de quem era: dado sob sigilo profissional, sem dono
     * e sem rastro. Para a LGPD isso não é eliminação (art. 16 e art. 18, VI).
     */
    await expect(getObject(c.storageKey)).rejects.toThrow();
  });

  it("conclui a exclusão mesmo se o armazenamento recusar um arquivo", async () => {
    const c = await contaCompleta("arquivo-sumido");
    /**
     * Chave que não corresponde a objeto nenhum simula o arquivo já removido por
     * fora, ou o armazenamento indisponível. Abortar aqui deixaria a conta pela
     * metade — estado pior que o inicial. A exclusão segue, e o que falhou é
     * DEVOLVIDO para quem operou, não engolido.
     */
    await prisma.document.create({
      data: {
        organizationId: c.orgId,
        filename: "inexistente.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        storageKey: `${PREFIXO}/nao-existe/arquivo-fantasma.pdf`,
      },
    });

    const r = await apagarConta(c.email);
    expect(r.apagado).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: c.userId } })).toBeNull();
    // O arquivo real foi removido; o fantasma não conta como falha no driver local,
    // que apaga com `force`. O que importa é a conta ter saído inteira.
    expect(r.arquivosRemovidos).toBeGreaterThanOrEqual(1);
  });

  it("deixa rastro do que foi apagado", async () => {
    const c = await contaCompleta("rastro");
    await apagarConta(c.email);

    /**
     * ⚠️ A BUSCA mudou, e a mudança é a garantia nova.
     *
     * Este teste procurava o registro pelo e-mail da conta. Agora o e-mail é trocado pelo
     * código no registro de segurança, então procurar por ele não acha nada — e é esse o
     * ponto. O que este teste sempre quis provar continua valendo: o rastro diz o TAMANHO do
     * estrago, não só que houve um. A busca passou a ser pelo id da conta, que é o vínculo
     * que sobrevive no metadado sem identificar ninguém.
     */
    const registro = await prisma.securityEvent.findFirst({
      where: { type: "conta_apagada", metadata: { path: ["userId"], equals: c.userId } },
      orderBy: { createdAt: "desc" },
    });
    expect(registro).toBeTruthy();
    const meta = registro!.metadata as Record<string, unknown>;
    expect(meta.userId).toBe(c.userId);
    expect(meta.analises).toBe(1);

    // E o e-mail NÃO está mais ali: ficou apenas o código da conta.
    expect(registro!.email).not.toBe(c.email);
    expect(registro!.email).toMatch(/^conta-apagada:/);
  });

  it("recusa conta inexistente em vez de estourar", async () => {
    const r = await apagarConta(`${PREFIXO}-nao-existe@exemplo.local`);
    expect(r.apagado).toBe(false);
    expect(r.recusa).toBe("nao_encontrada");
  });

  it("RECUSA apagar administrador", async () => {
    const c = await contaCompleta("admin", { perfil: "ADMIN" });

    const r = await apagarConta(c.email, { forcar: true });
    expect(r.apagado).toBe(false);
    expect(r.recusa).toBe("e_admin");
    // A trava tem de valer mesmo com --forcar: é como o dono se trancaria fora.
    expect(await prisma.user.findUnique({ where: { id: c.userId } })).toBeTruthy();
  });

  it("RECUSA apagar quem tem pagamento aprovado, sem forçar", async () => {
    const c = await contaCompleta("pagante", { statusPagamento: "APROVADO" });

    const r = await apagarConta(c.email);
    expect(r.apagado).toBe(false);
    expect(r.recusa).toBe("tem_pagamento_aprovado");
    expect(r.inventario?.pagamentosAprovados).toBe(1);
    expect(await prisma.user.findUnique({ where: { id: c.userId } })).toBeTruthy();
  });

  /**
   * Dinheiro a devolver bloqueia SEM opção de forçar, e é deliberado.
   *
   * Apagar a conta não apaga mais o valor — a linha é desligada da assinatura e
   * sobrevive na tela de pendências —, mas apaga o CREDOR: some o nome, some o e-mail,
   * e a devolução perde o destinatário. Devolver primeiro é sempre possível; desfazer a
   * exclusão, não.
   */
  it("RECUSA apagar quem tem quantia a devolver, mesmo forçando", async () => {
    const c = await contaCompleta("a-devolver", { statusPagamento: "PENDENTE" });

    const r = await apagarConta(c.email, { forcar: true });
    expect(r.apagado).toBe(false);
    expect(r.recusa).toBe("tem_pagamento_a_devolver");
    expect(r.inventario?.pagamentosADevolver).toBe(1);
    expect(await prisma.user.findUnique({ where: { id: c.userId } })).toBeTruthy();
  });

  it("apaga quem tem pagamento aprovado quando forçado de propósito", async () => {
    const c = await contaCompleta("pagante2", { statusPagamento: "APROVADO" });

    const r = await apagarConta(c.email, { forcar: true });
    expect(r.apagado).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: c.userId } })).toBeNull();
  });

  /**
   * ⚠️ A RECEITA sobrevive à exclusão forçada — e isto apareceu em produção.
   *
   * O pagamento APROVADO era apagado junto com a conta. Duas consequências, e a segunda só
   * ficou visível depois que a reconciliação passou a existir:
   *
   *  1. A receita realizada desaparecia dos livros. A própria mensagem de recusa dizia que
   *     "o registro da venda precisa ser guardado", e o caminho forçado o destruía.
   *  2. A reconciliação pergunta ao Asaas o que ele considera pago e aplica o que não tem
   *     registro aqui. Sem a linha, aquele pagamento era REDESCOBERTO na varredura seguinte
   *     e abria um caso: linha em "Dinheiro sem destino" — o indicador que o painel chama de
   *     mais urgente, porque cada real ali é alguém sem o que pagou — e alerta dizendo "quem
   *     pagou está sem serviço". Nada verdadeiro: ninguém esperava acesso, nada havia a
   *     devolver. Falso caso no número que menos pode ter falso, repetido a cada exclusão.
   *
   * O que este teste trava é a condição de que a reconciliação depende: existir linha com
   * aquele `externalId` é o que a faz reconhecer a cobrança como já vista.
   */
  /**
   * ⚠️ O e-mail sobrevivia dezenas de vezes no registro de SEGURANÇA.
   *
   * `SecurityEvent` guarda e-mail, IP e navegador, e NÃO tem vínculo com a conta — nenhuma
   * cascata a alcança. Então a função chamada "remoção definitiva" deixava o e-mail em claro
   * em toda tentativa de login falha, todo bloqueio por excesso de tentativas e toda falha
   * de segundo fator. Nada na tela dizia isso.
   *
   * Apagar as linhas seria errado de outro jeito: destruiria o histórico de segurança —
   * ataque de força bruta contra aquela conta deixa de existir, e a contagem que embasa
   * bloquear um IP vai com ele. Por isso o e-mail é TROCADO por um código estável: o
   * histórico continua servindo, o identificador sai.
   */
  it("troca o e-mail do rastro de segurança por um código, sem apagar o rastro", async () => {
    const c = await contaCompleta("seguranca");
    // Duas tentativas falhas de login da mesma conta, como a rota de login grava.
    await prisma.securityEvent.createMany({
      data: [
        { type: "login_failed", email: c.email, ip: "203.0.113.7" },
        { type: "login_failed", email: c.email, ip: "203.0.113.7" },
      ],
    });

    const inv = await inventarioDaConta(c.email);
    // Quem confirma a exclusão precisa saber o que sobrevive: o inventário diz.
    expect(inv!.rastroDeSeguranca).toBe(2);

    const r = await apagarConta(c.email);
    expect(r.apagado).toBe(true);
    // O registro da própria exclusão entra no rastro, então são as duas + ela.
    expect(r.rastroPseudonimizado).toBeGreaterThanOrEqual(2);

    // O e-mail não existe mais em lugar nenhum do registro de segurança.
    expect(await prisma.securityEvent.count({ where: { email: c.email } })).toBe(0);

    /**
     * E o histórico continua utilizável: as duas tentativas seguem lá, com o MESMO código,
     * que é o que permite ver "duas falhas da mesma conta" sem saber de quem.
     */
    const linhas = await prisma.securityEvent.findMany({ where: { type: "login_failed", ip: "203.0.113.7" } });
    expect(linhas).toHaveLength(2);
    expect(linhas[0]!.email).toMatch(/^conta-apagada:/);
    expect(linhas[1]!.email).toBe(linhas[0]!.email);
    // O IP fica: sem ele a contagem que embasa bloqueio perderia sentido.
    expect(linhas[0]!.ip).toBe("203.0.113.7");
  });

  /**
   * A prestação de contas é a única exceção deliberada, e sai de DENTRO da função.
   *
   * O painel já grava quem apagou, mas a função também é chamada pela linha de comando, onde
   * aquele registro não existe — e é ali que a exclusão é feita às pressas. Sem isto, o
   * caminho do terminal apagaria uma conta sem deixar em lugar nenhum QUAL conta era.
   */
  it("registra QUAL conta foi apagada, com o e-mail e o código para reencontrar o rastro", async () => {
    const c = await contaCompleta("contas");

    await apagarConta(c.email);

    const registro = await prisma.auditLog.findFirstOrThrow({
      where: { action: "conta.apagada", entityId: c.userId },
    });
    const meta = registro.metadata as Record<string, unknown>;
    expect(meta.email).toBe(c.email);
    /**
     * O código vai junto de propósito: é o que permite, partindo desta linha, achar no
     * registro de segurança o rastro daquela conta. Sem ele a pseudonimização seria mão
     * única e investigar incidente depois da exclusão ficaria impossível.
     */
    expect(String(meta.pseudonimo)).toMatch(/^conta-apagada:/);
    const linha = await prisma.securityEvent.findFirst({ where: { email: String(meta.pseudonimo) } });
    expect(linha).not.toBeNull();
  });

  it("exclusão forçada preserva o registro do dinheiro, sem dono", async () => {
    const c = await contaCompleta("receita", { statusPagamento: "APROVADO" });

    await apagarConta(c.email, { forcar: true });

    const pagamento = await prisma.payment.findFirstOrThrow({
      where: { externalId: c.externalIdPagamento },
    });
    // Sem dono: é o que a exclusão promete ao titular.
    expect(pagamento.subscriptionId).toBeNull();
    // Com valor e estado: é o que a contabilidade exige.
    expect(pagamento.status).toBe("APROVADO");
    expect(pagamento.amountCents).toBe(11990);
    /**
     * E sem o payload cru do provedor: `raw` foi feito para guardar a resposta do gateway,
     * que pode conter nome, e-mail ou documento. Preservar contabilidade não é desculpa para
     * preservar dado pessoal por descuido.
     */
    expect(pagamento.raw).toBeNull();

    // A conta, essa sim, foi embora inteira.
    expect(await prisma.user.findUnique({ where: { id: c.userId } })).toBeNull();
    expect(await prisma.subscription.findUnique({ where: { id: c.subId } })).toBeNull();
  });
});
