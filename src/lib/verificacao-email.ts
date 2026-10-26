import { prisma } from "./db";
import { randomToken, sha256 } from "./crypto";
import { sendEmail, renderEmail } from "./email";
import { env } from "./env";

/**
 * Emissão do e-mail de confirmação de cadastro — um lugar só.
 *
 * ── Por que existe ────────────────────────────────────────────────────────────
 * A regra estava escrita dentro da rota de cadastro: validade do link, texto do e-mail e
 * endereço de confirmação. Passou a ter um segundo cliente — o REENVIO —, e duas cópias da
 * mesma regra é como as duas divergem: bastaria alguém mudar a validade num lado para o
 * cliente receber um link que expira antes do que a tela promete.
 *
 * ── O reenvio existe porque faltava saída ─────────────────────────────────────
 * Não havia como pedir outro e-mail. Se o primeiro se perdia — caixa de spam, endereço com um
 * dígito errado depois corrigido pelo painel, entrega recusada pelo servidor de destino —, a
 * pessoa ficava com a conta pendente e nenhum caminho dentro do produto. O único jeito era
 * usar "esqueci minha senha", que verifica o e-mail como efeito colateral: funciona por
 * acidente, e ninguém adivinha isso.
 */

/**
 * Validade do link, em milissegundos.
 *
 * Dois dias: folga para quem só abre o e-mail no dia seguinte, sem deixar um link de ativação
 * de conta válido por semanas numa caixa de entrada que pode ser lida por outra pessoa.
 */
export const VALIDADE_DO_LINK_MS = 2 * 86_400_000;

/**
 * Contratar exige e-mail confirmado — decisão do dono.
 *
 * ── A falha que isto previne, e ela já aconteceu aqui ─────────────────────────
 * E-mail errado no cadastro só cobra o preço no momento em que alguém paga. Depois do
 * pagamento, TODO o contato com o cliente passa por aquele endereço: o aviso de acesso
 * liberado, a recuperação de senha, a segunda via do boleto, o aviso de cobrança e o de
 * devolução. Endereço inalcançável transforma uma venda em "paguei e nunca entrei", e sem
 * recuperação de senha a pessoa não tem como se resolver sozinha — este projeto já viveu isso,
 * e a correção de e-mail no painel administrativo existe por causa dele.
 *
 * Confirmar antes de cobrar troca um obstáculo de um clique por um problema que só se descobre
 * com dinheiro já pago.
 *
 * ── Onde NÃO vale, e por quê ──────────────────────────────────────────────────
 * Só na CONTRATAÇÃO. Compra de crédito avulso e troca de plano exigem assinatura com acesso,
 * isto é, alguém que já entrou — e o gate existe justamente para evitar quem paga e não entra.
 * Aplicá-lo ali seria atrito num cliente que já é cliente, sem prevenir a falha.
 *
 * ── Por que lê `emailVerifiedAt`, e não o status ──────────────────────────────
 * `status` seria mais barato, mas não é confiável para isto: a rota administrativa permite pôr
 * uma conta em ATIVO sem tocar em `emailVerifiedAt`, e a liberação manual marca o e-mail como
 * confirmado de propósito, porque ali o dono atesta a venda. O fato canônico é a data.
 */
export async function emailEstaConfirmado(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
  return Boolean(user?.emailVerifiedAt);
}

/**
 * Recusa da contratação por e-mail não confirmado.
 *
 * ⚠️ Texto ÚNICO, e ele precisa resolver o problema em vez de só anunciá-lo. Recusa numa tela
 * de pagamento é venda perdida se a pessoa não souber o próximo passo em uma leitura: diz o que
 * falta, onde está o botão que reenvia, e o caminho para quando o endereço está errado — este
 * último passou a ser saída própria do cliente, em Configurações, e não mais um pedido ao
 * atendimento.
 */
export const RECUSA_EMAIL_NAO_CONFIRMADO =
  "Confirme seu e-mail antes de contratar. Enviamos um link de confirmação para o endereço do seu " +
  "cadastro; se não chegou, confira a caixa de spam ou use o botão \"Reenviar o e-mail de " +
  "confirmação\" no aviso que aparece no topo da tela. Se o endereço estiver errado, troque-o em " +
  "Configurações → Trocar o e-mail da conta — sem um e-mail que funcione você não receberia o aviso " +
  "de acesso, a segunda via da cobrança nem a recuperação de senha.";

export interface ResultadoDaEmissao {
  /** O e-mail saiu? Falso não é erro fatal — a conta continua válida. */
  enviado: boolean;
  /**
   * Havia link vivo, e este reenvio o matou?
   *
   * Quem chama usa isto para AVISAR. Sem o aviso, a pessoa fica com dois e-mails na caixa, abre o
   * primeiro (que é o que ela lembra de ter recebido) e recebe "link inválido" — conclui que o
   * sistema está quebrado no exato momento em que ele acabou de funcionar.
   */
  substituiuAnteriores: boolean;
  /** Motivo real da falha, para o log de quem opera. Nunca vai para o cliente. */
  erro?: string;
}

/**
 * Cria um link novo de confirmação e envia. Não lança.
 *
 * ── Por que não lança ─────────────────────────────────────────────────────────
 * Quem chama está sempre num ponto em que a conta JÁ existe. Derrubar o cadastro porque o
 * provedor de e-mail piscou faria o cliente tentar de novo e receber "e-mail já cadastrado" —
 * conta criada, pessoa trancada fora, e nada explicando. O desfecho volta no retorno para
 * quem chamou poder dizer a verdade em vez de prometer um e-mail que não saiu.
 */
export async function emitirVerificacaoDeEmail(user: {
  id: string;
  email: string;
  name: string;
}): Promise<ResultadoDaEmissao> {
  /**
   * ⚠️ Os links anteriores são INVALIDADOS antes de emitir o novo.
   *
   * Sem isto, cada reenvio deixaria mais um link vivo por dois dias, todos funcionando. O
   * caso que importa é o do endereço digitado errado e depois corrigido: o link antigo foi
   * para a caixa de um terceiro, e ele continuaria podendo ativar a conta de outra pessoa.
   * Só o último link vale — é o que "reenviar" significa para quem clica.
   */
  /**
   * ⚠️ O AVISO conta só os links que ainda estavam VIVOS; a invalidação pega todos.
   *
   * A diferença importa para não mentir. "O link anterior deixou de valer" dito a quem tinha só um
   * link expirado há três dias sugere que ACABAMOS de derrubar algo — e a pessoa vai procurar na caixa
   * um e-mail que já não servia de nada, achando que perdeu a janela por pouco. Quem tinha link
   * vencido não perdeu nada agora; quem tinha link vivo perdeu, e é a esse que o aviso se destina.
   *
   * A invalidação segue pegando os vencidos também: token pendente de um pedido que não existe mais é
   * armadilha para quem for ler o estado depois.
   */
  const vivos = await prisma.authToken.count({
    where: { userId: user.id, type: "VERIFICACAO_EMAIL", usedAt: null, expiresAt: { gt: new Date() } },
  });
  await prisma.authToken.updateMany({
    where: { userId: user.id, type: "VERIFICACAO_EMAIL", usedAt: null },
    data: { usedAt: new Date() },
  });
  const substituiuAnteriores = vivos > 0;

  const token = randomToken(32);
  await prisma.authToken.create({
    data: {
      userId: user.id,
      type: "VERIFICACAO_EMAIL",
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + VALIDADE_DO_LINK_MS),
    },
  });

  const url = `${env.appUrl}/verificar-email?token=${token}`;
  /**
   * ⚠️ O AVISO VAI DENTRO DESTE E-MAIL, e é aqui que ele resolve o problema.
   *
   * Quem pediu o reenvio tem agora dois e-mails iguais na caixa. A tendência é abrir o de cima
   * — mas cliente de e-mail nem sempre ordena como se espera, e quem procurou por "Prescrição"
   * acha primeiro o antigo. Clicando nele, recebia "link inválido": a mensagem de erro mais
   * enganosa possível, porque o sistema tinha acabado de fazer exatamente o que foi pedido.
   *
   * Dizer no e-mail NOVO que ele substitui os anteriores é o único lugar onde a pessoa lê isso na
   * hora em que está escolhendo qual link abrir.
   */
  const substituicao = substituiuAnteriores
    ? `<p>Este é o link mais recente, e ele <strong>substitui os anteriores</strong>: se você tem outro ` +
      `e-mail nosso na caixa, ignore-o — só este funciona.</p>`
    : "";
  try {
    await sendEmail({
      to: user.email,
      subject: "Confirme seu cadastro — Prescrição Pro",
      html: renderEmail(
        "Confirme seu e-mail",
        `<p>Olá, ${user.name}.</p><p>Confirme seu e-mail para ativar sua conta. O link vale por 2 dias.</p>` +
          substituicao,
        { label: "Confirmar e-mail", url },
      ),
      text:
        `Confirme seu e-mail: ${url}` +
        (substituiuAnteriores ? "\n\nEste link substitui os anteriores: só ele funciona." : ""),
    });
    return { enviado: true, substituiuAnteriores };
  } catch (err) {
    const erro = (err as Error).message;
    console.error(`[verificacao-email] link criado, mas o e-mail para ${user.email} NÃO saiu:`, erro);
    return { enviado: false, substituiuAnteriores, erro };
  }
}
