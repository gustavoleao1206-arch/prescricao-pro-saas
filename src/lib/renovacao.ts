import type { Subscription } from "@prisma/client";

/**
 * Como esta assinatura continua — e como se fala disso na tela.
 *
 * ── O defeito que isto conserta ───────────────────────────────────────────────
 * O painel do cliente exibia um cartão fixo "Próxima renovação", com a data caindo
 * para o fim do período quando não havia renovação nenhuma:
 *
 *   <Stat label="Próxima renovação" value={nextRenewalAt ?? currentPeriodEnd} />
 *
 * Duas promessas falsas saíam daí, e o painel é a PRIMEIRA tela que o cliente vê:
 *
 *  - PIX é cobrança ÚNICA. Não existe mandato de débito em PIX, então o Asaas não tem
 *    como cobrar de novo: `nextRenewalAt` é nulo de propósito. O cliente lia uma data
 *    rotulada como renovação, não fazia nada, e descobria que não renovou quando o
 *    acesso parou.
 *  - Quem CANCELOU passou a ter `nextRenewalAt` nulo também (é o que o cancelamento
 *    grava). Ele lia "Próxima renovação: 14/08" no dia seguinte a pedir para parar de
 *    ser cobrado — a contradição mais visível que a tela pode ter.
 *
 * A tela de assinatura já distinguia o PIX, mas com a regra escrita nela mesma, e não
 * distinguia o cancelamento. Duas telas decidindo a mesma coisa por conta própria é como
 * elas divergem; o vocabulário passou a ser um só.
 *
 * ── Por que são TRÊS estados, e não dois ──────────────────────────────────────
 * "Renova" e "não renova" não bastam: dentro de "não renova" há duas situações
 * diferentes para quem lê. Contratação de ciclo único nunca prometeu renovar — não há
 * nada de errado, e o texto convida a contratar de novo. Contrato encerrado a pedido
 * renovava e deixou de renovar — o texto tem de confirmar que não haverá novas cobranças.
 * Chamar os dois de "pagamento único" mentiria para o segundo.
 */

export type ModoDeRenovacao = "renova" | "ciclo-unico" | "encerrando";

export interface Renovacao {
  modo: ModoDeRenovacao;
  /** Rótulo do cartão de data: "Próxima cobrança" ou "Acesso até". */
  rotuloDaData: string;
  data: Date | null;
  /** Linha curta sob o valor: como esta assinatura é cobrada. */
  formaDeCobranca: string;
  /** Há um ciclo seguinte? Governa toda frase que fala de "próxima renovação". */
  temProximoCiclo: boolean;
}

/** Estados em que a assinatura está terminando: renovava e deixou de renovar. */
const ENCERRANDO = ["CANCELADA", "ESTORNADA", "VENCIDA"];

export function renovacaoDe(
  sub: Pick<Subscription, "status" | "nextRenewalAt" | "currentPeriodEnd" | "canceledByRequestAt"> | null,
  opcoes: { emTolerancia?: boolean } = {},
): Renovacao {
  if (!sub) {
    return {
      modo: "ciclo-unico",
      rotuloDaData: "Acesso até",
      data: null,
      formaDeCobranca: "sem assinatura",
      temProximoCiclo: false,
    };
  }

  const encerrando = sub.canceledByRequestAt !== null || ENCERRANDO.includes(sub.status);
  if (encerrando) {
    return {
      modo: "encerrando",
      rotuloDaData: "Acesso até",
      data: sub.currentPeriodEnd,
      formaDeCobranca: "cancelada — não haverá novas cobranças",
      temProximoCiclo: false,
    };
  }

  /**
   * Dentro da tolerância de inadimplência a data que importa é até quando o acesso
   * resiste, não quando a próxima cobrança sai: o cliente precisa saber o prazo que tem
   * para regularizar.
   */
  if (opcoes.emTolerancia) {
    return {
      modo: "renova",
      rotuloDaData: "Acesso até",
      data: sub.currentPeriodEnd,
      formaDeCobranca: "pagamento em atraso",
      temProximoCiclo: true,
    };
  }

  if (sub.nextRenewalAt) {
    return {
      modo: "renova",
      rotuloDaData: "Próxima cobrança",
      data: sub.nextRenewalAt,
      formaDeCobranca: "renovação automática",
      temProximoCiclo: true,
    };
  }

  return {
    modo: "ciclo-unico",
    rotuloDaData: "Acesso até",
    data: sub.currentPeriodEnd,
    formaDeCobranca: "pagamento único, sem renovação",
    temProximoCiclo: false,
  };
}
