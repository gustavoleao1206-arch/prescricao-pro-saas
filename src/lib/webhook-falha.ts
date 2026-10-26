import { prisma } from "./db";
import { logSecurityEvent } from "./audit";
import { alertarOperacao } from "./alerta-operacional";

/**
 * O que fazer quando o processamento de um evento do provedor FALHA.
 *
 * ── Por que isto é mais grave do que parece ───────────────────────────────────
 * A rota do webhook devolvia 500 em qualquer erro inesperado, para o Asaas reenviar. A
 * intenção estava certa — pagamento não pode ser perdido por uma falha momentânea —, mas
 * o Asaas não trata a fila como um conjunto de entregas independentes: a fila de
 * sincronização da conta é INTERROMPIDA no evento que falha, e nenhum evento posterior é
 * entregue enquanto aquele não passar.
 *
 * Ou seja: um único evento que falha SEMPRE — dado inconsistente, chave duplicada,
 * cobrança de um plano apagado — para a entrada de TODOS os pagamentos seguintes. Ninguém
 * recebe acesso, ninguém renova, e do nosso lado o sintoma é "parou de chegar pagamento",
 * sem nada apontando para a causa. O defeito não custa um cliente: custa todos, a partir
 * daquele minuto.
 *
 * ── A decisão ─────────────────────────────────────────────────────────────────
 * Reenviar serve para falha TRANSITÓRIA (banco fora do ar, timeout). Não serve para falha
 * DETERMINÍSTICA: tentar de novo dá o mesmo erro para sempre, e o preço da tentativa é a
 * fila inteira. Nesses casos a resposta é 200 — o evento é dispensado — com registro e
 * ALERTA, porque dispensar em silêncio seria trocar um problema visível por um invisível.
 *
 * E há um teto de tentativas para o caso do erro que parece transitório e não é: passadas
 * as tentativas, a fila é liberada de qualquer forma e a operação é avisada. Nenhum
 * pagamento fica sem registro — o evento dispensado vai para o alerta com o corpo inteiro.
 */

/** Depois de quantas falhas do MESMO evento a fila é liberada mesmo assim. */
export const MAX_TENTATIVAS_WEBHOOK = 5;

/** Tipo do evento de segurança gravado a cada falha — também é o contador. */
const TIPO_FALHA = "webhook_falha_no_processamento";

/**
 * Códigos de erro do Prisma que significam "os dados não permitem esta operação".
 *
 * P2002 chave única duplicada, P2003 chave estrangeira, P2025 registro não encontrado,
 * P2000 valor longo demais para a coluna. Reenviar qualquer um deles produz exatamente o
 * mesmo erro, quantas vezes for.
 */
const CODIGOS_DETERMINISTICOS = ["P2000", "P2002", "P2003", "P2025"];

function ehDeterministico(err: unknown): boolean {
  const codigo = (err as { code?: unknown })?.code;
  if (typeof codigo === "string" && CODIGOS_DETERMINISTICOS.includes(codigo)) return true;
  /**
   * Erro de programação (ler propriedade de nulo, função inexistente) também é
   * determinístico: o mesmo corpo produz o mesmo defeito. Só `TypeError` entra, porque
   * `Error` genérico é o que a integração levanta em falha de rede.
   */
  return err instanceof TypeError;
}

export interface DecisaoDeFalha {
  /** Responder 500 para o provedor reenviar? */
  reenviar: boolean;
  tentativas: number;
  motivo: string;
}

/**
 * Registra a falha, conta as tentativas do mesmo evento e decide se vale reenviar.
 *
 * Nunca lança: é chamada do `catch` da rota, e uma exceção aqui devolveria 500 por
 * motivo diferente do original — escondendo a causa real atrás da falha do registro.
 */
export async function tratarFalhaDeWebhook(
  fonte: string,
  payload: Record<string, unknown>,
  err: unknown,
): Promise<DecisaoDeFalha> {
  const erro = (err as Error)?.message ?? String(err);
  const eventoId = typeof payload.id === "string" ? payload.id : null;
  const pagamento =
    typeof (payload.payment as { id?: unknown } | undefined)?.id === "string"
      ? ((payload.payment as { id: string }).id)
      : null;
  const nomeDoEvento = typeof payload.event === "string" ? payload.event : "desconhecido";

  /**
   * Quantas vezes ESTE evento já falhou. A contagem é pelo id do evento, que é o que o
   * provedor reenvia igual; sem ele, cai no id do pagamento. Sem os dois não há como
   * contar, e a resposta é reenviar — a falha pode ser transitória, e um evento sem
   * identificação é raro o suficiente para não travar a fila por muito tempo.
   */
  const chave = eventoId ?? pagamento;
  let tentativas = 1;
  if (chave) {
    const anteriores = await prisma.securityEvent
      .count({ where: { type: TIPO_FALHA, metadata: { path: ["chave"], equals: chave } } })
      .catch(() => 0);
    tentativas = anteriores + 1;
  }

  const determinístico = ehDeterministico(err);
  const excedeu = tentativas >= MAX_TENTATIVAS_WEBHOOK;
  const reenviar = !determinístico && !excedeu;

  const motivo = determinístico
    ? "falha determinística: reenviar produziria o mesmo erro e travaria a fila do provedor"
    : excedeu
      ? `falhou ${tentativas} vezes: a fila é liberada para não bloquear os pagamentos seguintes`
      : "falha possivelmente transitória: o provedor vai reenviar";

  await logSecurityEvent({
    type: TIPO_FALHA,
    metadata: { fonte, evento: nomeDoEvento, chave, pagamento, erro, tentativas, reenviar, motivo },
  });

  /**
   * Alerta só quando o evento é DISPENSADO. Enquanto há reenvio previsto, o caso pode se
   * resolver sozinho e avisar seria ruído; dispensado, ele nunca mais volta — e o corpo
   * vai no alerta porque é a única cópia que sobra do que aconteceu.
   */
  if (!reenviar) {
    await alertarOperacao({
      tipo: "webhook_evento_dispensado",
      assunto: `Evento de pagamento DISPENSADO após falha (${nomeDoEvento})`,
      linhas: [
        `Origem: ${fonte}.`,
        `Evento: ${nomeDoEvento}${eventoId ? ` (id ${eventoId})` : ""}.`,
        `Cobrança: ${pagamento ?? "não identificada"}.`,
        `Tentativas: ${tentativas}.`,
        `Erro: ${erro}`,
        `Motivo da dispensa: ${motivo}.`,
        `Corpo recebido: ${JSON.stringify(payload).slice(0, 800)}`,
      ],
      acao:
        "Confira a cobrança no painel do provedor e aplique o efeito à mão (liberar ciclo, registrar estorno)." +
        " A fila foi liberada de propósito: sem isso, nenhum pagamento posterior seria entregue.",
      metadata: { fonte, evento: nomeDoEvento, chave, pagamento, erro, tentativas },
    });
  }

  return { reenviar, tentativas, motivo };
}
