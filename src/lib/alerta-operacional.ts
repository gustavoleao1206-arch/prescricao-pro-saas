import { sendEmail, renderEmail } from "./email";
import { env } from "./env";
import { FORNECEDOR } from "./fornecedor";
import { logSecurityEvent } from "./audit";

/**
 * Alerta operacional: o aviso que sai da máquina e chega numa pessoa.
 *
 * ── O defeito que isto conserta ───────────────────────────────────────────────
 * Havia um único destino para "aconteceu algo que precisa de gente": a tabela de
 * eventos de segurança. Registrar ali é necessário e não é suficiente — ninguém
 * abre o painel de logs por acaso, e a tela nem mostrava os detalhes do registro.
 *
 * O caso concreto: pagamento que entra e não consegue ser vinculado a nenhuma
 * conta. O webhook respondia 200 ao Asaas, gravava uma linha em `SecurityEvent` e
 * terminava. Nenhuma cobrança registrada, nenhum chamado, nenhum e-mail. Do lado de
 * fora: alguém pagou, não recebeu acesso, não recebeu devolução e não recebeu
 * resposta. Aconteceu de verdade no primeiro pagamento real do produto, e o defeito
 * continuava aberto para todo dinheiro que chega sem dono identificável.
 *
 * Aqui o registro continua sendo a base — nunca se perde, mesmo que o e-mail falhe —
 * e ganha um segundo caminho, que é o e-mail para quem opera o negócio.
 *
 * ── Por que nunca lança ───────────────────────────────────────────────────────
 * Quem chama está sempre no meio de um webhook de pagamento ou de uma ação
 * administrativa que já mexeu em dinheiro. Se a queda do provedor de e-mail
 * derrubasse esta função, o webhook devolveria erro para um pagamento que ENTROU, o
 * Asaas reenviaria o evento em laço e o alerta seguiria não chegando. O alerta é o
 * último passo: falhar nele degrada o aviso, não a operação. O motivo da falha volta
 * na resposta para quem chamou poder dizer isso com honestidade.
 */

export interface AlertaOperacional {
  /**
   * Vira `SecurityEvent.type`. Use o mesmo vocabulário do resto do sistema
   * (`asaas_...`) para o filtro do painel continuar funcionando.
   */
  tipo: string;
  /** Assunto do e-mail. Uma frase, sem id nem jargão: é o que aparece no celular. */
  assunto: string;
  /** Corpo em linhas curtas — cada uma um fato, na ordem em que importa. */
  linhas: string[];
  /**
   * O que a pessoa deve FAZER. Sai em destaque porque alerta sem próximo passo
   * vira ruído, e ruído é ignorado justamente quando importa.
   */
  acao?: string;
  /** Vai para o registro de segurança, não para o e-mail. */
  metadata?: Record<string, unknown>;
}

export interface ResultadoAlerta {
  destino: string;
  /** O e-mail saiu? O registro é gravado de qualquer forma. */
  avisado: boolean;
  erro?: string;
}

/**
 * Para onde o alerta vai.
 *
 * `OPERACAO_EMAIL` permite separar o endereço de operação do contato público (o
 * público está nos documentos legais e é lido por clientes). Sem a variável, cai no
 * contato do fornecedor — endereço errado é ruim, endereço nenhum é pior.
 */
export function destinoDoAlerta(): string {
  return env.email.operacao.trim() || FORNECEDOR.email;
}

/** Escapa o que vai para o HTML: parte do texto vem de mensagem de erro do provedor. */
function escapar(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function alertarOperacao(alerta: AlertaOperacional): Promise<ResultadoAlerta> {
  const destino = destinoDoAlerta();

  // Primeiro o registro, sempre. É a memória que sobrevive à falha do e-mail.
  await logSecurityEvent({
    type: alerta.tipo,
    metadata: { ...(alerta.metadata ?? {}), assunto: alerta.assunto, alertaEnviadoPara: destino },
  });

  const corpo =
    `<ul style="padding-left:18px;margin:0">` +
    alerta.linhas.map((l) => `<li style="margin-bottom:6px">${escapar(l)}</li>`).join("") +
    `</ul>` +
    (alerta.acao
      ? `<p style="margin-top:16px;padding:12px;background:#FEF3C7;border-radius:8px">` +
        `<strong>O que fazer:</strong> ${escapar(alerta.acao)}</p>`
      : "");

  const texto = [
    alerta.assunto,
    "",
    ...alerta.linhas.map((l) => `- ${l}`),
    ...(alerta.acao ? ["", `O que fazer: ${alerta.acao}`] : []),
  ].join("\n");

  try {
    await sendEmail({
      to: destino,
      // O prefixo permite criar um filtro no e-mail e não perder o alerta na caixa.
      subject: `[${env.appName}] ${alerta.assunto}`,
      html: renderEmail(alerta.assunto, corpo),
      text: texto,
    });
    return { destino, avisado: true };
  } catch (err) {
    const erro = (err as Error).message;
    console.error(`[alerta] ${alerta.tipo}: o e-mail para ${destino} NÃO saiu:`, erro);
    return { destino, avisado: false, erro };
  }
}

/** Valor em reais para o corpo do alerta. */
export function emReais(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
