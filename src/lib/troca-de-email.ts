import { prisma } from "./db";
import { randomToken, sha256 } from "./crypto";
import { verifyPassword } from "./password";
import { sendEmail, renderEmail } from "./email";
import { logAudit, logSecurityEvent } from "./audit";
import { env } from "./env";


/**
 * Troca de e-mail pedida pelo próprio cliente.
 *
 * ── Por que passou a ser necessária ───────────────────────────────────────────
 * Contratar exige e-mail confirmado, e trocar o e-mail só era possível pelo atendimento. Com
 * as duas coisas juntas, um endereço digitado errado no cadastro virava venda que não se
 * completa até alguém do suporte agir — atrito no caminho do dinheiro, criado por um conserto.
 *
 * ── É caminho de TOMADA DE CONTA, e o desenho vem daí ─────────────────────────
 * Quem controla o e-mail de uma conta controla a conta: recuperação de senha vai para lá. Uma
 * troca de e-mail mal feita é, portanto, uma porta de sequestro. Quatro decisões saem disso:
 *
 *  1. **Exige a senha atual.** Sessão roubada (máquina emprestada, cookie capturado) não basta
 *     para apontar a conta para outro endereço. Sem isto, o encerramento por inatividade que
 *     acabamos de construir seria contornável: bastaria pegar uma tela aberta e trocar o
 *     e-mail para tomar a conta em definitivo.
 *
 *  2. **A troca só vale depois de clicar no link enviado ao endereço NOVO.** É o que prova
 *     controle do destino. Aplicar na hora deixaria a conta apontada para um endereço que o
 *     cliente talvez não controle — por engano de digitação ou por engano de quem pediu.
 *
 *  3. **O endereço ANTIGO é avisado, e o aviso não pode ser desligado.** É por ele que o dono
 *     legítimo descobre uma troca que não pediu, enquanto ainda dá para reagir. É a única
 *     defesa que funciona depois de a senha ter vazado.
 *
 *  4. **Link curto.** Uma hora, como a redefinição de senha — e não os dois dias da
 *     confirmação de cadastro. Link de troca de e-mail parado numa caixa de entrada por dois
 *     dias é uma janela aberta à espera de quem leia aquela caixa.
 */

/** Validade do link de confirmação. Curta de propósito — ver decisão 4 acima. */
export const VALIDADE_DA_TROCA_MS = 60 * 60_000;

/**
 * Cancela a troca de e-mail pendente: apaga o endereço e mata o link.
 *
 * ⚠️ ESTA FUNÇÃO EXISTE POR UM DEFEITO GRAVE, e vale escrever o caminho inteiro.
 *
 * O aviso ao endereço antigo dizia — e diz — "troque sua senha agora". Só que trocar a senha
 * NÃO desarmava o pedido: nem `POST /api/conta/senha`, que gravava apenas o hash novo, nem
 * `redefinir-senha`, que revoga sessões mas marca só o próprio token de recuperação. O link do
 * atacante continuava válido pela hora inteira, e a confirmação é rota PÚBLICA — não exige
 * sessão nem senha. Então:
 *
 *   atacante com a senha pede a troca → vítima recebe o aviso e OBEDECE, troca a senha →
 *   atacante clica no link → e-mail da conta passa a ser dele → "esqueci minha senha" no
 *   endereço novo → conta e assinatura paga tomadas.
 *
 * A vítima fazia exatamente o que o produto instruiu, no prazo, e perdia a conta de qualquer
 * jeito. Defeito pior que a ausência do aviso: um alarme que orienta para uma ação inútil ensina
 * a pessoa a confiar no lugar errado.
 *
 * Trocar a senha passou a cancelar o pedido. É a mesma ideia de `revokeAllSessions` na troca de
 * senha: credencial nova invalida o que a credencial velha autorizou.
 *
 * Vale também como cancelamento pedido de propósito — o cliente que digitou o endereço errado
 * precisa de um jeito de desfazer, e sem isto o ÚNICO jeito de matar um link era pedir a troca
 * para um TERCEIRO endereço, porque pedir de volta o endereço atual é recusado por "email_igual".
 * Ninguém deduz isso sob pressão.
 */
export async function cancelarTrocaDeEmailPendente(
  userId: string,
  motivo: string,
  contexto: { ip?: string } = {},
): Promise<{ cancelou: boolean; endereco: string | null }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pendingEmail: true, email: true },
  });
  const pendente = user?.pendingEmail ?? null;

  /**
   * Limpar `pendingEmail` é o que de fato barra o link: sem pedido pendente, a confirmação não
   * tem o que aplicar e recusa por "sem_pedido". Invalidar o token é REDUNDÂNCIA declarada —
   * não conheço cenário em que ela seja o que protege, porque `pedirTrocaDeEmail` já invalida os
   * anteriores antes de criar o próximo. Fica porque é barata, deixa o estado coerente (token
   * pendente de pedido que não existe é armadilha para quem ler depois) e porque reforço em
   * caminho de tomada de conta se justifica sem precisar de cenário.
   */
  const tokens = await prisma.authToken.updateMany({
    where: { userId, type: "TROCA_EMAIL", usedAt: null },
    data: { usedAt: new Date() },
  });

  if (!pendente && tokens.count === 0) return { cancelou: false, endereco: null };

  await prisma.user.update({ where: { id: userId }, data: { pendingEmail: null } });
  await logAudit({
    action: "conta.troca_email_cancelada",
    entityType: "User",
    entityId: userId,
    /** O IP importa quando o cancelamento é ATO do titular, para separar de quem só trocou a senha. */
    ip: contexto.ip,
    metadata: { enderecoPretendido: pendente, linksInvalidados: tokens.count, motivo },
  });

  return { cancelou: true, endereco: pendente };
}

export type RecusaDaTroca =
  | "senha_incorreta"
  /** Travada por tentativas erradas — a MESMA trava do login. Ver `pedirTrocaDeEmail`. */
  | "conta_travada"
  | "email_invalido"
  | "email_igual"
  | "email_em_uso"
  | "sem_senha";

export interface PedidoDeTroca {
  aceito: boolean;
  recusa?: RecusaDaTroca;
  /** O e-mail saiu para o endereço novo? Falso não desfaz o pedido. */
  enviado?: boolean;
  /**
   * Endereço do pedido ANTERIOR, que este substituiu — nulo se não havia nenhum.
   *
   * Existe para a tela poder dizer. Pedir de novo mata o link anterior, e quem não é avisado disso
   * fica com dois e-mails na caixa sem saber que só o último vale: abre o antigo, recebe recusa e
   * conclui que a troca não funciona.
   */
  substituiu?: string | null;
}

/** Formato mínimo, o mesmo já usado na correção pelo painel. */
function formatoValido(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

/**
 * Registra o pedido de troca e manda o link para o endereço novo.
 *
 * Não aplica nada em `email` — ver `confirmarTrocaDeEmail`.
 */
export async function pedirTrocaDeEmail(
  userId: string,
  novoEmailBruto: string,
  senha: string,
  contexto: { ip?: string } = {},
): Promise<PedidoDeTroca> {
  const novoEmail = novoEmailBruto.trim().toLowerCase();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  /**
   * Conta sem senha existe: a liberação manual cria o cliente e manda link para ele criar a
   * senha. Enquanto ele não criou, não há o que conferir — e deixar passar sem senha
   * transformaria "sem senha" no caminho mais fácil de trocar o e-mail de uma conta.
   */
  if (!user.passwordHash) return { aceito: false, recusa: "sem_senha" };

  /**
   * ⚠️ A conta travada pelo login também está travada aqui.
   *
   * Sem esta linha, esta rota era um ORÁCULO DE SENHA que ignorava o bloqueio do login: quem
   * tivesse uma sessão roubada podia testar senhas por aqui indefinidamente, porque a conferência
   * não olhava `lockedUntil` e o erro não contava para `failedLoginCount`. O login trava depois de
   * poucas tentativas; esta rota não travava nunca, e o único teto era um balde EM MEMÓRIA que
   * zera a cada deploy.
   *
   * Uma trava, um lugar: a mesma que o login usa.
   */
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { aceito: false, recusa: "conta_travada" };
  }

  if (!(await verifyPassword(senha, user.passwordHash))) {
    /**
     * A tentativa errada CONTA para a trava do login, com o mesmo limite e o mesmo prazo. Errar
     * aqui e errar no login passam a somar no mesmo lugar — senão bastaria alternar entre as duas
     * rotas para nunca travar.
     */
    const tentativas = user.failedLoginCount + 1;
    const travar = tentativas >= env.security.loginMaxAttempts;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: travar ? 0 : tentativas,
        lockedUntil: travar ? new Date(Date.now() + env.security.loginLockMinutes * 60_000) : null,
      },
    });
    /**
     * Registro de segurança: senha errada numa troca de e-mail é o sintoma de alguém tentando
     * tomar a conta com uma sessão que não é dele. Sem isto, a tentativa não deixa rastro
     * nenhum — e é a única coisa que distingue erro de digitação de ataque em curso.
     */
    await logSecurityEvent({
      type: "troca_email_senha_incorreta",
      email: user.email,
      ip: contexto.ip,
      metadata: { destinoPretendido: novoEmail, tentativas, travou: travar },
    });
    return { aceito: false, recusa: "senha_incorreta" };
  }

  /** Acertou: zera o contador, como o login faz. Senão a trava chegaria por erros antigos. */
  if (user.failedLoginCount > 0) {
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0 } });
  }

  if (!formatoValido(novoEmail)) return { aceito: false, recusa: "email_invalido" };
  if (novoEmail === user.email) return { aceito: false, recusa: "email_igual" };

  const ocupado = await prisma.user.findUnique({ where: { email: novoEmail }, select: { id: true } });
  if (ocupado) return { aceito: false, recusa: "email_em_uso" };

  /**
   * Pedidos anteriores são invalidados antes de criar o novo. Sem isto, cada tentativa deixaria
   * mais um link vivo, cada um apontando para um endereço diferente — e um link antigo,
   * clicado depois, moveria a conta para um destino que o cliente já havia abandonado.
   */
  const token = randomToken(32);
  /**
   * ⚠️ As TRÊS escritas numa transação só, e a invalidação estava fora dela.
   *
   * O token não é vinculado ao endereço para o qual foi enviado: ele aplica o que estiver pendente
   * NA HORA DO CLIQUE. Isso só é seguro enquanto existir no máximo um token vivo, e ele
   * corresponder ao `pendingEmail` corrente — invariante que a transação garante e que a versão
   * anterior deixava quebrar: uma falha entre a invalidação e a criação deixaria token velho vivo
   * junto de um endereço pendente novo, e o link antigo passaria a aplicar o endereço novo.
   */
  await prisma.$transaction([
    prisma.authToken.updateMany({
      where: { userId, type: "TROCA_EMAIL", usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({ where: { id: userId }, data: { pendingEmail: novoEmail } }),
    prisma.authToken.create({
      data: {
        userId,
        type: "TROCA_EMAIL",
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + VALIDADE_DA_TROCA_MS),
      },
    }),
  ]);

  const url = `${env.appUrl}/confirmar-troca-email?token=${token}`;
  /**
   * ⚠️ O e-mail avisa que substitui o anterior — mesmo aviso que a confirmação de cadastro dá.
   *
   * Sai só quando o pedido substituído ia para o MESMO endereço, e é aí que o aviso resolve algo: a
   * pessoa tem dois e-mails iguais na caixa e precisa saber que só o último funciona. Se o pedido
   * anterior ia para outro endereço, este destinatário nunca viu aquele link, e mencioná-lo seria
   * contar a ele para onde a conta ia antes — informação que não é dele.
   */
  const substituiNestaCaixa = user.pendingEmail === novoEmail;
  let enviado = true;
  try {
    await sendEmail({
      to: novoEmail,
      subject: "Confirme seu novo e-mail — Prescrição Pro",
      html: renderEmail(
        "Confirme seu novo e-mail",
        `<p>Olá, ${user.name}.</p><p>Recebemos um pedido para passar a usar este endereço na sua conta do Prescrição Pro. ` +
          `Confirme para a troca valer. O link expira em 1 hora.</p>` +
          (substituiNestaCaixa
            ? `<p>Este é o link mais recente, e ele <strong>substitui o anterior</strong>: se você tem outro ` +
              `e-mail nosso na caixa, ignore-o — só este funciona.</p>`
            : "") +
          `<p>Se não foi você, ignore este e-mail: nada muda sem esta confirmação.</p>`,
        { label: "Confirmar novo e-mail", url },
      ),
      text:
        `Confirme seu novo e-mail: ${url}` +
        (substituiNestaCaixa ? "\n\nEste link substitui o anterior: só ele funciona." : ""),
    });
  } catch (err) {
    enviado = false;
    console.error(`[troca-email] pedido registrado, mas o e-mail para ${novoEmail} NÃO saiu:`, (err as Error).message);
  }

  /**
   * ⚠️ AVISO AO ENDEREÇO ANTIGO — a defesa que sobra quando a senha já vazou.
   *
   * É por aqui que o dono legítimo descobre uma troca que não pediu, enquanto ainda dá para
   * reagir. Falha no envio não desfaz o pedido — mas fica gravada, porque um pedido de troca
   * cujo aviso não saiu é exatamente o caso em que ninguém foi avisado de nada.
   */
  try {
    await sendEmail({
      to: user.email,
      subject: "Pedido de troca do e-mail da sua conta — Prescrição Pro",
      html: renderEmail(
        "Alguém pediu para trocar o e-mail da sua conta",
        `<p>Olá, ${user.name}.</p><p>Recebemos um pedido para trocar o e-mail da sua conta para ` +
          `<strong>${novoEmail}</strong>. A troca só vale depois de ser confirmada nesse novo endereço.</p>` +
          `<p><strong>Se não foi você, troque sua senha agora</strong> — isso CANCELA este pedido ` +
          `imediatamente e derruba o link enviado ao outro endereço. Quem pediu a troca sabia sua ` +
          `senha, então troque também em qualquer outro site onde você use a mesma. Depois, fale com ` +
          `o suporte.</p>`,
      ),
      /**
       * ⚠️ O texto AFIRMA que trocar a senha cancela o pedido, e agora isso é verdade.
       *
       * Antes ele mandava trocar a senha e trocar a senha não desarmava nada: o link seguia válido
       * pela hora inteira, e a confirmação é rota pública. A vítima obedecia, no prazo, e perdia a
       * conta de qualquer jeito. Instrução que não protege é pior que instrução nenhuma — ensina a
       * pessoa a confiar no lugar errado, e ela para de procurar a saída real.
       *
       * Se alguém mexer no cancelamento em `/api/conta/senha` ou em `redefinir-senha`, esta frase
       * volta a ser mentira. Há teste nos dois caminhos (tests/troca-email-e-senha.test.ts).
       */
      text:
        `Recebemos um pedido para trocar o e-mail da sua conta para ${novoEmail}. Se não foi você, ` +
        `troque sua senha agora: isso cancela o pedido e derruba o link. Depois fale com o suporte.`,
    });
  } catch (err) {
    await logSecurityEvent({
      type: "troca_email_aviso_ao_antigo_falhou",
      email: user.email,
      ip: contexto.ip,
      metadata: { destinoPretendido: novoEmail, erro: (err as Error).message },
    });
  }

  await logAudit({
    actorId: userId,
    action: "conta.troca_email_pedida",
    entityType: "User",
    entityId: userId,
    ip: contexto.ip,
    metadata: { de: user.email, paraPretendido: novoEmail, emailEnviado: enviado },
  });

  return { aceito: true, enviado, substituiu: user.pendingEmail };
}

export type MotivoDaRecusa =
  /** Token que não existe, ou de outro tipo. */
  | "link_invalido"
  /** Existe, nunca foi usado, e a hora passou. */
  | "link_expirado"
  /** ⚠️ Já foi usado, E FOI ESTE que aplicou a troca. Não é erro: é o desfecho que a pessoa queria. */
  | "ja_confirmado"
  /** Já foi usado porque o cliente pediu a troca DE NOVO depois; há um pedido mais recente vivo. */
  | "link_substituido"
  /** Já foi usado e não há pedido pendente: foi cancelado (troca de senha) ou resolvido por outro link. */
  | "link_encerrado"
  /** Token válido, mas nenhum endereço pendente para aplicar. */
  | "sem_pedido"
  | "email_em_uso";

export type ResultadoDaConfirmacao =
  | { ok: true; de: string; para: string }
  /**
   * `aplicado` só vem em "ja_confirmado", e vem da AUDITORIA — não de `user.email`.
   *
   * A diferença importa: se a conta trocou de endereço mais uma vez depois deste link, `user.email`
   * seria um terceiro endereço, e a tela o revelaria a quem só teve acesso ao segundo. A auditoria
   * diz o que ESTE link aplicou, que é exatamente o que quem clicou já sabia.
   */
  | { ok: false; motivo: MotivoDaRecusa; aplicado?: string | null };

/**
 * ⚠️ POR QUE "link_substituido" NÃO DEVOLVE O ENDEREÇO PENDENTE.
 *
 * A primeira versão devolvia — `pendente: user.pendingEmail` — para a tela poder dizer qual dos dois
 * e-mails da caixa abrir. A revisão de segurança derrubou isso, e com razão: era um vazamento justamente
 * no cenário que é a RAZÃO DE EXISTIR desta funcionalidade.
 *
 *   O cliente digita o endereço novo errado (`joao@exemplo.co`), e o link vai para a caixa de um
 *   terceiro. Ele percebe, pede a troca de novo para `joao@exemplo.com.br` — o token antigo é invalidado e
 *   `pendingEmail` passa a ser o endereço certo. O terceiro abre o link que recebeu. A rota é PÚBLICA,
 *   sem sessão e sem senha, e a tela lhe informava o endereço real do cliente.
 *
 * Ou seja: dado pessoal de cliente entregue a um estranho, mais a indicação de qual caixa atacar para
 * tomar a conta — porque aquele endereço vira o login assim que o titular confirmar. E o vazamento não
 * tinha prazo: "já usado" é conferido antes de "expirado", então o link morto responderia para sempre.
 *
 * O erro de raciocínio foi supor a MESMA caixa nos dois pedidos. É verdade para quem pediu duas
 * trocas de propósito; é falso exatamente no erro de digitação. E como o token não é vinculado ao
 * endereço (invariante declarado deste módulo), a rota não tem como distinguir os dois — revela para
 * os dois igualmente.
 *
 * `aplicado`, em "ja_confirmado", é diferente e continua saindo: aquele endereço é comprovadamente
 * controlado por quem clicou, porque o link chegou nele E a troca foi aplicada nele. Não há o que
 * revelar a quem já sabia.
 */

/**
 * O que aconteceu com um link de troca que já foi usado.
 *
 * ── O defeito que isto conserta ───────────────────────────────────────────────
 * Todo token já usado caía em "este link é inválido ou expirou. Peça a troca novamente". Inclusive
 * — e principalmente — o caso mais comum de todos: a pessoa confirma, DÁ CERTO, e volta ao link.
 * Recarregar a aba, clicar de novo no e-mail, ou simplesmente ter um cliente de e-mail que pré-abre
 * links para gerar a pré-visualização. Ela lia "inválido" logo depois de ter dado certo, concluía
 * que a troca falhou e pedia outra — gastando o limite de 5 em 15 minutos e, pior, deixando um novo
 * `pendingEmail` no lugar de uma conta que já estava correta.
 *
 * ── Os três desfechos, e como se distinguem ───────────────────────────────────
 * `usedAt` é gravado por três caminhos diferentes: a confirmação, o cancelamento (que é o que
 * trocar a senha faz) e o pedido seguinte, que invalida o anterior. O campo sozinho não distingue.
 *
 *  1. **A auditoria da confirmação guarda o id do link** (`linkId`), então "foi este que aplicou"
 *     é uma pergunta com resposta exata — e ainda diz PARA QUAL endereço.
 *  2. **Rede de segurança sem a auditoria:** `logAudit` é best-effort, engole o próprio erro e só
 *     imprime no console. Fazer o conserto principal — não anunciar fracasso depois do sucesso —
 *     depender de uma escrita que pode falhar em silêncio seria construir sobre areia: banco sob
 *     pressão, e a troca CONCLUÍDA voltaria a ser reportada como cancelada.
 *
 *     A rede é comparar `emailVerifiedAt` com o `usedAt` deste token. Os dois são gravados na MESMA
 *     transação de `confirmarTrocaDeEmail`, por `new Date()` do MESMO processo — mesmo relógio, sem a
 *     defasagem que existiria contra o `createdAt` da auditoria, que vem do Postgres. Coincidirem em
 *     poucos segundos só acontece de um jeito: foi este token que confirmou o endereço atual. O
 *     cancelamento não toca `emailVerifiedAt`, e o pedido seguinte também não.
 *
 *     A rede não sabe QUAL endereço foi aplicado (isso só a auditoria guarda), então devolve
 *     `aplicado: null` e a rota usa a frase sem endereço. Perde-se detalhe, não a verdade.
 *  3. Sem nada disso e COM endereço pendente: houve pedido novo depois. ⚠️ O endereço NÃO sai daqui —
 *     ver o bloco acima sobre o vazamento.
 *  4. Sem nada disso e sem pendência: cancelado, ou substituído por pedido que já se resolveu.
 *
 * Links usados ANTES desta mudança não têm `linkId` na auditoria, mas passam pela rede do caso 2 se
 * foram eles que confirmaram. Degradação silenciosa de propósito: a mensagem fica mais genérica,
 * nunca errada.
 */

/** Folga para os dois `new Date()` da mesma transação. Microssegundos na prática; 5s é conforto. */
const FOLGA_DO_MESMO_INSTANTE_MS = 5_000;

async function explicarLinkJaUsado(registro: {
  id: string;
  createdAt: Date;
  usedAt: Date | null;
  user: { id: string; pendingEmail: string | null; emailVerifiedAt: Date | null };
}): Promise<ResultadoDaConfirmacao> {
  const confirmacao = await prisma.auditLog.findFirst({
    where: {
      action: "conta.troca_email_confirmada",
      entityType: "User",
      entityId: registro.user.id,
      metadata: { path: ["linkId"], equals: registro.id },
    },
    select: { metadata: true },
  });

  if (confirmacao) {
    const meta = (confirmacao.metadata ?? {}) as { para?: unknown };
    return { ok: false, motivo: "ja_confirmado", aplicado: typeof meta.para === "string" ? meta.para : null };
  }

  /**
   * Caso 2: a auditoria não saiu, mas o estado da conta ainda denuncia que foi este link.
   *
   * ⚠️ SÃO DUAS CONDIÇÕES, e a primeira versão só tinha a segunda — que sozinha dava FALSO POSITIVO.
   *
   * Comparar apenas `emailVerifiedAt` com `usedAt` dizia "já deu certo" para qualquer conta cujo
   * e-mail tivesse sido confirmado nos cinco segundos ao redor da invalidação do token — e a
   * invalidação por CANCELAMENTO ou por pedido novo cai nessa janela facilmente. Dois testes pegaram:
   * um link substituído e um link cancelado eram anunciados como bem-sucedidos, o que é o pior erro
   * possível aqui — dizer à vítima de uma tentativa de tomada de conta que a troca foi aplicada.
   *
   * A condição que fecha é `emailVerifiedAt >= createdAt do token`: a confirmação grava a data DEPOIS
   * de o token existir, enquanto uma data herdada do cadastro ou de outro caminho é sempre mais
   * antiga que ele. Junto da coincidência com o `usedAt`, sobra um único cenário — foi este token.
   */
  const confirmadoEm = registro.user.emailVerifiedAt?.getTime();
  const usadoEm = registro.usedAt?.getTime();
  const confirmadoDepoisDoLink = confirmadoEm !== undefined && confirmadoEm >= registro.createdAt.getTime();
  if (
    confirmadoEm &&
    usadoEm &&
    confirmadoDepoisDoLink &&
    Math.abs(confirmadoEm - usadoEm) <= FOLGA_DO_MESMO_INSTANTE_MS
  ) {
    return { ok: false, motivo: "ja_confirmado", aplicado: null };
  }

  if (registro.user.pendingEmail) return { ok: false, motivo: "link_substituido" };

  return { ok: false, motivo: "link_encerrado" };
}

/**
 * Aplica a troca, se o link for válido.
 *
 * ── Não exige sessão, e isso é deliberado ─────────────────────────────────────
 * O link chega na caixa do endereço NOVO, que a pessoa pode abrir no celular, sem estar
 * logada. Exigir sessão aqui empurraria o cliente a um login que ele talvez não consiga fazer
 * — e não acrescentaria segurança: o pedido já exigiu a senha, e o link já prova o controle do
 * destino. Duas provas antes desta tela.
 */
export async function confirmarTrocaDeEmail(token: string): Promise<ResultadoDaConfirmacao> {
  const registro = await prisma.authToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          pendingEmail: true,
          status: true,
          /** Lido para a rede de segurança de `explicarLinkJaUsado` — ver o caso 2 lá. */
          emailVerifiedAt: true,
        },
      },
    },
  });

  /**
   * O tipo é conferido PRIMEIRO, e antes de qualquer explicação.
   *
   * Sem isso, um link de recuperação de senha — que chega ao endereço ANTIGO — valeria como
   * confirmação da troca, e a prova de controle do destino desapareceria. E a explicação do "já
   * usado" abaixo só vale para tokens de troca: aplicá-la a outros tipos daria informação sobre
   * links que nada têm a ver com esta tela.
   */
  if (!registro || registro.type !== "TROCA_EMAIL") return { ok: false, motivo: "link_invalido" };

  /** Já usado vem antes de expirado: o desfecho é mais informativo que o prazo. */
  if (registro.usedAt) return explicarLinkJaUsado(registro);
  if (registro.expiresAt < new Date()) return { ok: false, motivo: "link_expirado" };

  const novoEmail = registro.user.pendingEmail;
  if (!novoEmail) return { ok: false, motivo: "sem_pedido" };

  /**
   * ⚠️ A unicidade é conferida DE NOVO aqui.
   *
   * Entre o pedido e o clique cabe uma hora, e nela alguém pode ter cadastrado justamente esse
   * endereço. Sem esta conferência, a aplicação estouraria com erro de banco na cara de quem
   * clicou — e a mensagem seria incompreensível. Pior: é o caminho por onde duas contas
   * disputariam o mesmo e-mail.
   */
  const ocupado = await prisma.user.findUnique({ where: { email: novoEmail }, select: { id: true } });
  if (ocupado && ocupado.id !== registro.user.id) return { ok: false, motivo: "email_em_uso" };

  const de = registro.user.email;
  await prisma.$transaction([
    prisma.user.update({
      where: { id: registro.user.id },
      data: {
        email: novoEmail,
        pendingEmail: null,
        /**
         * O endereço novo está confirmado por este próprio clique — foi nele que o link chegou.
         * Marcar a data é o que permite a pessoa contratar em seguida, que é o motivo pelo qual
         * ela trocou o e-mail. Não marcar deixaria a troca resolvida e a compra ainda barrada.
         */
        emailVerifiedAt: new Date(),
        /**
         * ⚠️ O status só sobe de PENDENTE_VERIFICACAO para ATIVO. Nunca desfaz bloqueio.
         *
         * Gravava `status: "ATIVO"` sem olhar o atual, e isto era uma porta grave: a confirmação
         * é rota PÚBLICA — sem sessão e sem senha —, então quem tivesse um link válido de uma
         * conta BLOQUEADA ou SUSPENSA a reativava clicando. Bloqueio administrativo desfeito por
         * clique em e-mail, e por caminho que nem pede para provar quem é.
         *
         * O único status que esta confirmação tem autoridade para mudar é o que ela de fato
         * resolve: a pendência de verificação de e-mail. Bloqueio e suspensão são decisão de
         * quem administra, e voltar delas é ato de quem as aplicou.
         */
        ...(registro.user.status === "PENDENTE_VERIFICACAO" ? { status: "ATIVO" as const } : {}),
      },
    }),
    prisma.authToken.update({ where: { id: registro.id }, data: { usedAt: new Date() } }),
    /**
     * Links de VERIFICAÇÃO pendentes são invalidados: eles foram emitidos para o endereço
     * antigo, e um deles clicado depois reconfirmaria um endereço que já não é o da conta.
     */
    prisma.authToken.updateMany({
      where: { userId: registro.user.id, type: "VERIFICACAO_EMAIL", usedAt: null },
      data: { usedAt: new Date() },
    }),
  ]);

  await logAudit({
    actorId: registro.user.id,
    action: "conta.troca_email_confirmada",
    entityType: "User",
    entityId: registro.user.id,
    /**
     * ⚠️ `linkId`, e NÃO `tokenId`: o saneamento de `logAudit` substitui por "[REDIGIDO]" toda
     * chave cujo nome contenha "token". O valor aqui é o id da LINHA em AuthToken — um cuid, não o
     * segredo que foi para o e-mail —, mas o filtro olha o nome da chave, não o conteúdo. Com o
     * nome errado, o campo gravaria "[REDIGIDO]" e a explicação de "este link já valeu" nunca
     * encontraria nada: um defeito silencioso, com tudo compilando e a suíte verde.
     *
     * É este campo que `explicarLinkJaUsado` procura para poder dizer "já deu certo" em vez de
     * "link inválido" a quem reabre o link depois de a troca ter funcionado.
     */
    metadata: { de, para: novoEmail, linkId: registro.id },
  });

  /**
   * O endereço antigo é avisado do desfecho, não só do pedido. Quem foi vítima precisa saber
   * que a troca se concretizou — é a diferença entre "alguém tentou" e "você perdeu o
   * controle da conta", e as duas pedem reações diferentes.
   */
  try {
    await sendEmail({
      to: de,
      subject: "O e-mail da sua conta foi alterado — Prescrição Pro",
      html: renderEmail(
        "O e-mail da sua conta foi alterado",
        `<p>Olá, ${registro.user.name}.</p><p>O e-mail da sua conta passou a ser <strong>${novoEmail}</strong>. ` +
          `Este endereço não recebe mais os avisos da conta.</p>` +
          `<p><strong>Se não foi você</strong>, fale com o suporte imediatamente.</p>`,
      ),
      text: `O e-mail da sua conta passou a ser ${novoEmail}. Se não foi você, fale com o suporte imediatamente.`,
    });
  } catch (err) {
    console.error("[troca-email] troca aplicada, mas o aviso ao endereço antigo NÃO saiu:", (err as Error).message);
  }

  return { ok: true, de, para: novoEmail };
}
