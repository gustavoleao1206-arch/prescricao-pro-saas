import { prisma } from "./db";
import { env } from "./env";
import { safeEqual } from "./crypto";
import { logAudit, logSecurityEvent } from "./audit";
import { liberarCreditosDoCiclo, creditarPacote } from "./credits";
import {
  sendActivated,
  sendReactivated,
  sendRenewalConfirmed,
  sendPaymentLate,
  sendCanceled,
  sendPaymentWhileSuspended,
  sendRefunded,
  sendUndueCharge,
} from "./subscription-emails";
import { alertarOperacao, emReais } from "./alerta-operacional";
import { garantirOrganizacao } from "./tenant";
import { aplicarPlanoAgendado, aplicarUpgrade, ehSubidaDePlano } from "./mudanca-plano";
import { DIAS_TOLERANCIA_INADIMPLENCIA, DIAS_COMPENSACAO_BOLETO } from "./planos";
import { somarDiasUteis } from "./revisao-contestacao";
import type { Plan, Subscription, SubscriptionStatus, PaymentStatus } from "@prisma/client";

/**
 * Integração com o Asaas — checkout hospedado + webhook.
 *
 * Desenho (ver ASAAS.md):
 *  - O botão "Assinar" chama `criarCheckout`, que cria uma sessão de checkout no
 *    Asaas e devolve o link hospedado. O cliente informa CPF e forma de pagamento
 *    na página do Asaas (por isso não precisamos coletar CPF antes).
 *  - Cada checkout carrega um `externalReference` no formato
 *    `plano:<slug>:user:<userId>` (ou `pacote:...`), que amarra o pagamento à
 *    conta sem depender de e-mail.
 *  - Ao pagar, o Asaas chama `/api/webhooks/asaas`. Validamos o header
 *    `asaas-access-token` e processamos o evento, reaproveitando o mesmo miolo
 *    de créditos/assinatura (liberarCreditosDoCiclo etc.).
 *
 * Idempotência: `recordPayment` deduplica por (externalId + status) e a
 * liberação de créditos é idempotente pela chave do ciclo, então o reenvio de
 * um evento — ou o par CONFIRMED→RECEIVED do mesmo pagamento — não credita duas
 * vezes.
 */

// ---------------------------------------------------------------------------
// Configuração e cliente HTTP
// ---------------------------------------------------------------------------

export function asaasConfigured(): boolean {
  return Boolean(env.asaas.apiKey);
}

class AsaasError extends Error {
  status: number;
  corpo: unknown;
  constructor(message: string, status: number, corpo?: unknown) {
    super(message);
    this.name = "AsaasError";
    this.status = status;
    this.corpo = corpo;
  }
}

/**
 * Teto de espera por resposta do Asaas.
 *
 * Sem teto, o `fetch` do Node espera indefinidamente. Isso importa porque estas
 * chamadas ficam no caminho de operações que já mexeram em dinheiro: no cancelamento
 * pelo painel, a gravação acontece antes e a auditoria e o e-mail ao cliente vêm
 * DEPOIS da chamada ao gateway — um travamento deixava a assinatura cancelada sem
 * registro de auditoria e sem aviso ao assinante, e a requisição pendurada até o
 * tempo limite do servidor. Vinte segundos é folgado para a API do Asaas e curto o
 * bastante para o erro ser tratado: falha de cancelamento vira alerta, e alerta é
 * acionável; travamento não vira nada.
 */
const TIMEOUT_ASAAS_MS = 20_000;

async function asaasFetch(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  if (!env.asaas.apiKey) throw new AsaasError("ASAAS_API_KEY não configurada.", 500);
  const res = await fetch(`${env.asaas.apiBaseUrl}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_ASAAS_MS),
    ...init,
    headers: {
      "Content-Type": "application/json",
      // O Asaas recomenda um User-Agent que identifique a aplicação.
      "User-Agent": "PrescricaoPro/1.0 (Node.js)",
      access_token: env.asaas.apiKey,
      ...(init.headers ?? {}),
    },
  });
  const texto = await res.text();
  let json: Record<string, unknown>;
  try {
    json = texto ? (JSON.parse(texto) as Record<string, unknown>) : {};
  } catch {
    json = { raw: texto };
  }
  if (!res.ok) {
    const erros = (json as { errors?: Array<{ description?: string }> }).errors;
    const msg = erros?.[0]?.description || `Asaas respondeu ${res.status}.`;
    throw new AsaasError(msg, res.status, json);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Criação de checkout (chamada pelo botão "Assinar" / "Comprar")
// ---------------------------------------------------------------------------

export interface CheckoutInput {
  /**
   * "plano" é contratação recorrente. "pacote" e "upgrade" são cobranças AVULSAS:
   * o pacote de créditos e a diferença proporcional da troca de plano não criam
   * recorrência nova — no upgrade, a recorrência existente é que passa a cobrar o
   * valor do plano novo.
   */
  tipo: "plano" | "pacote" | "upgrade";
  slug: string;
  nome: string;
  valorCents: number;
  userId: string;
  /** Só para plano: MENSAL vira MONTHLY; ANUAL vira YEARLY. */
  cycle?: "MONTHLY" | "YEARLY";
  /**
   * Forma de pagamento do PLANO, escolhida pelo cliente ANTES de abrir o checkout.
   *
   * Não é preferência de interface: define se o Asaas cria uma assinatura
   * recorrente ou uma cobrança única, e isso muda o que o cliente contrata.
   *
   *  - "cartao" → RECURRENT: o Asaas cobra sozinho a cada ciclo.
   *  - "pix"    → DETACHED: cobrança única, SEM renovação. O acesso vale um ciclo
   *               e encerra; o cliente precisa comprar de novo.
   *
   * "boleto" NÃO é aceito aqui, e passar esse valor levanta erro. O Checkout do
   * Asaas não emite boleto — `billingTypes` admite apenas CREDIT_CARD e PIX
   * (docs.asaas.com/reference/create-new-checkout). Boleto vive na API de
   * Assinaturas, por `criarAssinaturaBoleto`.
   */
  metodo?: MetodoDePagamento;
}

export type MetodoDePagamento = "cartao" | "pix" | "boleto";

/**
 * Formas que o cliente pode escolher para contratar um plano.
 *
 * `renova` não é detalhe de interface: é o que o cliente está contratando, e a
 * página de planos escreve isso no botão. Cartão e boleto renovam (o Asaas cria a
 * cobrança do ciclo seguinte sozinho); o PIX não tem como renovar, porque não
 * existe mandato de débito em PIX — acaba quando o período termina.
 *
 * `viaCheckout` distingue o caminho técnico: cartão e PIX usam o checkout
 * hospedado, onde o Asaas coleta o CPF; o boleto usa a API de Assinaturas, e aí
 * somos nós que pedimos o documento antes.
 */
export const METODOS_DE_PLANO: {
  valor: MetodoDePagamento;
  rotulo: string;
  renova: boolean;
  viaCheckout: boolean;
}[] = [
  { valor: "cartao", rotulo: "Cartão de crédito", renova: true, viaCheckout: true },
  { valor: "pix", rotulo: "PIX", renova: false, viaCheckout: true },
  { valor: "boleto", rotulo: "Boleto bancário", renova: true, viaCheckout: false },
];

/** Converte texto de query string em método, com recuo no cartão. */
export function metodoDeTexto(valor: string | null | undefined): MetodoDePagamento {
  const achado = METODOS_DE_PLANO.find((m) => m.valor === valor);
  return achado ? achado.valor : "cartao";
}

/** Data de hoje em YYYY-MM-DD (primeira cobrança do ciclo = agora). */
function hojeISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Cria uma sessão de checkout no Asaas e devolve o link para o cliente pagar.
 *
 * Plano  → cobrança RECORRENTE (assinatura), só cartão de crédito, porque é a
 *          forma que renova automaticamente sem o cliente refazer o processo.
 * Pacote / upgrade → cobrança avulsa (DETACHED), aceitando PIX ou cartão.
 *
 * ── O id da sessão é gravado aqui, e isso é essencial ─────────────────────────
 * O `externalReference` continua sendo enviado, porque nas cobranças avulsas o
 * Asaas o devolve no evento. Nas RECORRENTES ele NÃO devolve — verificado na API
 * com o primeiro pagamento real: nulo no pagamento e nulo na assinatura. O que a
 * assinatura traz é `checkoutSession`, o id desta sessão.
 *
 * Guardar esse id agora, junto de quem está comprando, é o que torna o vínculo
 * determinístico: não depende de o provedor devolver nenhum dado nosso. Sem isto,
 * um pagamento de assinatura entra no gateway e não há como saber de quem é —
 * exatamente o que aconteceu em produção.
 */
export async function criarCheckout(input: CheckoutInput): Promise<{ url: string }> {
  const valor = Number((input.valorCents / 100).toFixed(2));
  const ehPlano = input.tipo === "plano";
  const metodo: MetodoDePagamento = input.metodo ?? "cartao";
  /**
   * Boleto por aqui produziria uma cobrança em PIX sem ninguém perceber: o
   * Checkout ignora `billingTypes` que não conhece e o cliente que pediu boleto
   * cairia numa tela de PIX. Falhar alto é o certo — quem chama com boleto está
   * usando a função errada.
   */
  if (metodo === "boleto") {
    throw new AsaasError(
      "O Checkout do Asaas não emite boleto. Use criarAssinaturaBoleto (API de Assinaturas).",
      500,
    );
  }
  /**
   * Plano no cartão é a única combinação recorrente possível.
   *
   * Plano no PIX é cobrança ÚNICA: o PIX não tem mandato de débito, então não há
   * como o Asaas cobrar sozinho no mês seguinte. Pacote e upgrade sempre foram
   * avulsos por natureza.
   */
  const ehRecorrente = ehPlano && metodo === "cartao";
  const externalReference = `${input.tipo}:${input.slug}:user:${input.userId}`;

  const body: Record<string, unknown> = {
    billingTypes: ehRecorrente ? ["CREDIT_CARD"] : ehPlano ? ["PIX"] : ["PIX", "CREDIT_CARD"],
    chargeTypes: ehRecorrente ? ["RECURRENT"] : ["DETACHED"],
    minutesToExpire: 60,
    externalReference,
    callback: {
      successUrl: `${env.appUrl}/assinatura?status=sucesso`,
      cancelUrl: `${env.appUrl}/assinatura?status=cancelado`,
      expiredUrl: `${env.appUrl}/assinatura?status=expirado`,
    },
    items: [{ name: input.nome, description: input.nome, quantity: 1, value: valor }],
  };
  if (ehRecorrente) {
    body.subscription = { cycle: input.cycle ?? "MONTHLY", nextDueDate: hojeISO() };
  }

  const res = await asaasFetch("/checkouts", { method: "POST", body: JSON.stringify(body) });
  const url = (res as { link?: string }).link;
  if (!url) throw new AsaasError("Checkout criado, mas o Asaas não devolveu o link.", 502, res);

  /**
   * O id vem no campo `id` da resposta; se algum dia não vier, ainda está no fim
   * da URL de pagamento (`.../checkoutSession/show/<id>`). Vale tentar os dois: é
   * este id que amarra o pagamento futuro à conta.
   */
  const idDaSessao = (res as { id?: string }).id ?? url.split("/").pop() ?? null;
  if (idDaSessao) {
    try {
      await prisma.asaasCheckout.upsert({
        where: { id: idDaSessao },
        update: { tipo: input.tipo, slug: input.slug, userId: input.userId },
        create: { id: idDaSessao, tipo: input.tipo, slug: input.slug, userId: input.userId },
      });
    } catch (err) {
      // Não impedir a compra por causa do registro auxiliar: o cliente já está
      // indo pagar. Mas avisar alto, porque sem ele a liberação vai falhar.
      console.error("[asaas] checkout criado, mas o vínculo NÃO foi gravado:", (err as Error).message);
    }
  } else {
    console.error("[asaas] checkout criado sem id identificável — a liberação automática pode falhar.");
  }

  return { url };
}

// ---------------------------------------------------------------------------
// Boleto: cliente + assinatura pela API, fora do Checkout
// ---------------------------------------------------------------------------

/**
 * Marca em `canceledReason` que o atraso é de boleto e termina em cancelamento.
 *
 * Não é enfeite: a manutenção diária precisa distinguir o atraso de CARTÃO — que
 * espera nova tentativa do gateway e pode se resolver sozinho — do boleto vencido,
 * que não tem retentativa e encerra a assinatura.
 */
export const MOTIVO_BOLETO_VENCIDO = "Boleto vencido sem pagamento";

/** Cancelamento pedido pelo próprio assinante, na tela de assinatura. */
export const MOTIVO_CANCELAMENTO_CLIENTE = "Cancelamento solicitado pelo cliente";

/** Cancelamento feito pelo administrador, no painel. */
export const MOTIVO_CANCELAMENTO_ADMIN = "Cancelado pelo administrador";

/**
 * Existe um PEDIDO DE PARADA nesta assinatura?
 *
 * ── Por que esta pergunta decide o destino do dinheiro ────────────────────────
 * Quando um pagamento chega para uma assinatura cancelada, o sistema tratava todos
 * os casos igual: gravava ATIVA e liberava a cota. Isso está certo em UM caso e
 * errado no outro, e o caso errado é cobrança indevida:
 *
 *  - Cancelada por FALTA DE PAGAMENTO (boleto vencido): o dinheiro que chega é o
 *    cliente pagando, com atraso. Reativar é o que ele espera e comprou.
 *
 *  - Cancelada A PEDIDO: o cliente disse para parar. Dinheiro que chega depois é
 *    quantia que não devia ter saído da conta dele — e ressuscitar a assinatura
 *    transforma um erro de cobrança em serviço imposto. O cliente cancela, vê a
 *    cobrança no extrato, entra no sistema e encontra a assinatura ATIVA de novo:
 *    a leitura inevitável é a de que o cancelamento foi ignorado de propósito.
 *
 * ── Por que NÃO se pergunta pelo status nem pelo texto do motivo ──────────────
 * Foi assim na primeira versão desta garantia, e ela se desarmava sozinha. Quatro
 * caminhos reescrevem `status` e `canceledReason` depois do cancelamento:
 * `handleStatus` grava INADIMPLENTE quando o cartão é recusado; `handleCancelado`
 * grava "Cancelamento via Asaas" — disparado pelo PAYMENT_DELETED que o NOSSO
 * próprio DELETE da recorrência provoca; `ativarAssinatura` zerava os dois; e o
 * estorno grava ESTORNADA. Bastava um passar no meio para o pedido de parada
 * desaparecer, e a cobrança seguinte reativava a assinatura.
 *
 * `canceledByRequestAt` é o registro do pedido, e nada além de uma contratação nova
 * o apaga.
 */
export function canceladaAPedido(sub: { canceledByRequestAt: Date | null }): boolean {
  return sub.canceledByRequestAt !== null;
}

/** O que gravar quando o cliente, ou o admin por ele, pede para parar de cobrar. */
export function pedidoDeParada(motivo: string, agora = new Date()) {
  return {
    status: "CANCELADA" as const,
    canceledAt: agora,
    canceledReason: motivo,
    canceledByRequestAt: agora,
    /**
     * Prometer renovação a quem pediu para parar é a contradição mais visível que a
     * tela pode ter — `nextRenewalAt` é o que o painel exibe como "Próxima cobrança".
     * E downgrade agendado para depois do fim não tem mais o que agendar.
     */
    nextRenewalAt: null,
    pendingPlanId: null,
    pendingPlanAt: null,
  };
}

/**
 * Parada da COBRANÇA sem encerrar a assinatura.
 *
 * Existe para um caso só, e ele é armadilha: a assinatura está em REVISÃO de contestação
 * (SUSPENSA ou ESTORNADA) e o cliente pede para parar de ser cobrado.
 *
 * Gravar o encerramento comum ali destruiria a revisão — o estado dela é o próprio
 * status, e `canceledAt` é o relógio do prazo que a Política promete. Reescrever esses
 * campos apagaria o direito do assinante ao restabelecimento por decurso de prazo e
 * REINICIARIA o prazo em favor de quem devia cumpri-lo. Então aqui só se registra o
 * pedido de parada e se apaga a promessa de renovação; status, motivo e data do
 * cancelamento ficam onde estão.
 */
export function paradaDeCobrancaSemEncerrar(agora = new Date()) {
  return {
    canceledByRequestAt: agora,
    nextRenewalAt: null,
    pendingPlanId: null,
    pendingPlanAt: null,
  };
}

/**
 * Este pagamento é uma contratação NOVA de quem havia pedido para parar?
 *
 * É a única pergunta que separa "o cliente voltou por vontade própria" de "a cobrança
 * que ele mandou parar entrou de novo". Sem ela, o conserto quebraria a recontratação;
 * com ela frouxa, a cobrança indevida passa por compra nova.
 *
 * Duas evidências, ambas de coisa que só existe DEPOIS do pedido de parada:
 *  - uma sessão de checkout criada depois dele (cartão e PIX passam por checkout); ou
 *  - uma recorrência do Asaas diferente da que foi mandada parar (o boleto contrata
 *    criando uma assinatura nova na API, com id novo).
 *
 * O que NÃO é evidência: `externalReference`. Ele viaja no cadastro da assinatura do
 * Asaas e chega igual em toda cobrança dela — inclusive nas da contratação parada.
 * Foi exatamente por confiar nele que o boleto do ciclo, pago com atraso, ressuscitava
 * a assinatura de quem havia cancelado.
 */
async function ehContratacaoNova(
  sub: { externalRef: string | null; canceledByRequestAt: Date | null },
  pay: AsaasPayment,
): Promise<boolean> {
  const pedido = sub.canceledByRequestAt;
  if (!pedido) return true;

  if (pay.checkoutSession) {
    const sessao = await prisma.asaasCheckout.findUnique({ where: { id: pay.checkoutSession } });
    if (sessao && sessao.createdAt.getTime() > pedido.getTime()) return true;
  }

  if (pay.subscription && sub.externalRef && pay.subscription !== sub.externalRef) return true;

  return false;
}

/**
 * O `externalRef` aponta para uma RECORRÊNCIA do Asaas (`sub_...`)?
 *
 * Em cobrança única (PIX) o campo guarda o id do PAGAMENTO (`pay_...`). Pedir ao
 * Asaas para cancelar uma "assinatura" que é um pagamento devolve erro — e o erro
 * seria lido como "não conseguimos interromper a cobrança", alarme falso justamente
 * para quem pagou por PIX, onde não existe cobrança futura a interromper.
 */
export function ehRecorrencia(externalRef: string | null): boolean {
  return Boolean(externalRef?.startsWith("sub_"));
}

/**
 * Encerra as assinaturas cujo boleto venceu e a janela de compensação passou.
 *
 * Chamada pela manutenção diária. Cancela também a recorrência no Asaas: sem isso
 * o provedor seguiria emitindo boleto todo mês para quem já perdeu o acesso —
 * cobrar sem entregar é pior que não cobrar.
 *
 * Idempotente: quem já está CANCELADA não é encontrado pelo filtro.
 */
/**
 * `dueDate` do Asaas (AAAA-MM-DD) como data, ao MEIO-DIA UTC.
 *
 * O meio-dia evita o deslocamento de fuso: "2026-08-04" interpretado como meia-noite UTC
 * volta um dia no horário de Brasília, e a janela de compensação começaria 24 horas antes
 * do vencimento real — encurtando justamente o prazo que protege quem pagou em dia.
 */
function dataDoVencimento(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T12:00:00.000Z`);
  return isNaN(d.getTime()) ? null : d;
}

/** Estados em que o Asaas considera a cobrança PAGA (ou com dinheiro a caminho). */
const STATUS_PAGO_NO_ASAAS = ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"];

export interface ConsultaDeCobranca {
  /** Existe cobrança paga (ou em compensação) nesta recorrência? */
  paga: boolean;
  /** A consulta não pôde ser feita. Diferente de "não há pagamento". */
  falhou: boolean;
  motivo?: string;
  /** Status encontrados, para o registro dizer o que foi visto. */
  statusVistos?: string[];
}

/**
 * Pergunta ao Asaas se a recorrência tem cobrança PAGA.
 *
 * ── Por que existe ────────────────────────────────────────────────────────────
 * O encerramento por boleto vencido faz duas coisas irreversíveis: cancela a assinatura
 * e APAGA a recorrência no provedor. Isso era feito sem perguntar nada a ele — só pelo
 * relógio do nosso banco. Se o webhook de pagamento se perdeu, atrasou além da janela ou
 * falhou ao ser processado, o cliente que PAGOU perdia o acesso e a recorrência, e nada
 * no sistema sabia que havia dinheiro dele lá.
 *
 * A distinção entre "não há pagamento" e "não consegui perguntar" é o ponto: passo
 * irreversível não se toma com informação faltando. Consulta que falha ADIA o
 * encerramento para a próxima varredura, e o motivo fica registrado.
 */
export async function cobrancaPagaNoProvedor(externalRef: string | null): Promise<ConsultaDeCobranca> {
  if (!externalRef || !ehRecorrencia(externalRef)) {
    // Sem recorrência no provedor não há o que consultar nem o que apagar.
    return { paga: false, falhou: false };
  }
  if (!asaasConfigured()) {
    return { paga: false, falhou: true, motivo: "integração com o Asaas não configurada" };
  }
  try {
    const resposta = await asaasFetch(`/subscriptions/${encodeURIComponent(externalRef)}/payments`, {
      method: "GET",
    });
    const cobrancas = (resposta as { data?: Array<Record<string, unknown>> }).data ?? [];
    const statusVistos = cobrancas.map((c) => String(c.status ?? "?"));
    return {
      paga: statusVistos.some((st) => STATUS_PAGO_NO_ASAAS.includes(st.toUpperCase())),
      falhou: false,
      statusVistos,
    };
  } catch (err) {
    const motivo = (err as Error).message;
    console.error(`[asaas] não consegui conferir as cobranças de ${externalRef}:`, motivo);
    return { paga: false, falhou: true, motivo };
  }
}

// ---------------------------------------------------------------------------
// Reconciliação — o dinheiro que o Asaas confirmou e o webhook não entregou
// ---------------------------------------------------------------------------

/**
 * A liberação de acesso não pode depender do webhook CHEGAR.
 *
 * ── O problema, na forma em que ele acontece ───────────────────────────────────
 * Todo o acesso do produto era liberado por um único gatilho: o webhook do Asaas
 * batendo na nossa porta. Gatilho único é ponto único de falha, e este falha de
 * verdade, por três caminhos conhecidos:
 *
 *  - A fila do Asaas é INTERROMPIDA no evento que falha. Um evento que dá erro
 *    permanente para a entrega de TODOS os posteriores — inclusive os pagamentos de
 *    outros clientes. Já aconteceu neste projeto.
 *  - Deploy, reinício ou indisponibilidade momentânea no meio da entrega.
 *  - Evento não marcado no painel do Asaas, ou token de webhook divergente: recusa
 *    silenciosa, 401 de um lado e nada do outro.
 *
 * Em todos, o desfecho é o mesmo e é o pior que existe: o cliente pagou e não recebeu.
 * O remédio era humano — alguém percebia e liberava à mão — o que significa que quem
 * pagasse à noite ficava sem acesso até alguém olhar.
 *
 * ── O que esta função faz ─────────────────────────────────────────────────────
 * Pergunta ao Asaas quais cobranças ele considera PAGAS no período e aplica as que não
 * têm registro aqui, pelo MESMO caminho do webhook (`processAsaasEvent`). Não há regra
 * duplicada: toda garantia, todo alerta e toda chave de idempotência que valem para o
 * evento valem para a reconciliação, porque é literalmente o mesmo código.
 *
 * A idempotência sai de graça e por construção: `handleAprovado` trata como reenvio
 * qualquer cobrança cujo id já esteja gravado como paga, então webhook e reconciliação
 * podem aplicar o mesmo pagamento em qualquer ordem sem somar período duas vezes.
 *
 * ── O que ela NÃO faz ─────────────────────────────────────────────────────────
 * Não inventa liberação: nada é aplicado sem o Asaas afirmar que a cobrança foi paga. E
 * não confunde "não havia nada" com "não consegui perguntar" — falha volta como falha,
 * porque um zero mentiroso aqui esconderia exatamente o cliente que está sem acesso.
 */
export interface ResultadoReconciliacao {
  /** Cobranças pagas que o Asaas listou no período. */
  consultadas: number;
  /** Já tinham registro aqui — o webhook fez o trabalho dele. */
  jaConhecidas: number;
  /** Aplicadas agora. Cada uma é um cliente que estava sem o que pagou. */
  liberadas: number;
  /** Aplicadas sem liberar acesso (dinheiro sem dono, pedido de parada, avulsa). */
  semLiberacao: number;
  /** A consulta não pôde ser feita. Diferente de "não havia nada". */
  falhou: boolean;
  motivo?: string;
  /** Havia mais páginas do que o teto: o resultado NÃO é o quadro completo. */
  truncada: boolean;
}

const PAGINA_RECONCILIACAO = 100;
/**
 * Teto de páginas por status. Existe para a varredura não virar laço infinito se o Asaas
 * ignorar o filtro de data — e quando é atingido, isso é DITO (ver `truncada`). Varredura
 * que corta silenciosamente se parece com varredura que não achou nada.
 */
const MAX_PAGINAS_RECONCILIACAO = 20;
/**
 * Sete dias: cobre fila travada durante um fim de semana prolongado sem transformar a
 * consulta num inventário da conta inteira.
 */
const DIAS_RECONCILIACAO = 7;

/** Ação de auditoria de cada pagamento recuperado — é o rastro que distingue do webhook. */
export const ACAO_PAGAMENTO_RECUPERADO = "asaas.pagamento_recuperado_por_reconciliacao";

/** Nome do evento a sintetizar, para o texto gravado dizer a verdade sobre o que era. */
function eventoDoStatus(status: string): string {
  return status.toUpperCase() === "CONFIRMED" ? "PAYMENT_CONFIRMED" : "PAYMENT_RECEIVED";
}

export async function reconciliarPagamentos(
  opcoes: { desde?: Date; agora?: Date } = {},
): Promise<ResultadoReconciliacao> {
  const r: ResultadoReconciliacao = {
    consultadas: 0,
    jaConhecidas: 0,
    liberadas: 0,
    semLiberacao: 0,
    falhou: false,
    truncada: false,
  };

  if (!asaasConfigured()) {
    r.falhou = true;
    r.motivo = "ASAAS_API_KEY ausente neste processo";
    /**
     * Alerta, e não só log: sem a chave esta varredura não faz NADA, e o sintoma externo é
     * idêntico ao de tudo funcionando — nenhum erro, nenhuma linha vermelha. Foi assim que
     * o cron diário passou a existir sem poder falar com o Asaas.
     */
    await alertarOperacao({
      tipo: "asaas_reconciliacao_sem_credencial",
      assunto: "A reconciliação de pagamentos rodou SEM poder consultar o Asaas",
      linhas: [
        "A varredura que libera acesso quando o webhook falha não pôde ser executada.",
        "Motivo: a chave de API do Asaas não está disponível neste processo.",
        "Enquanto isso, pagamento cujo webhook se perder NÃO libera acesso sozinho.",
      ],
      acao:
        "Confira se ASAAS_API_KEY e ASAAS_ENV estão definidas no serviço que roda a manutenção" +
        " diária (no Render, no recurso de cron — não só no site).",
      metadata: { source: "reconciliacao" },
    });
    return r;
  }

  const agora = opcoes.agora ?? new Date();
  const desde = opcoes.desde ?? new Date(agora.getTime() - DIAS_RECONCILIACAO * 86_400_000);
  const dia = desde.toISOString().slice(0, 10);

  for (const status of STATUS_PAGO_NO_ASAAS) {
    for (let pagina = 0; pagina < MAX_PAGINAS_RECONCILIACAO; pagina++) {
      let corpo: Record<string, unknown>;
      try {
        corpo = await asaasFetch(
          `/payments?status=${encodeURIComponent(status)}` +
            `&paymentDate%5Bge%5D=${dia}` +
            `&limit=${PAGINA_RECONCILIACAO}&offset=${pagina * PAGINA_RECONCILIACAO}`,
          { method: "GET" },
        );
      } catch (err) {
        r.falhou = true;
        r.motivo = `${status}: ${(err as Error).message}`;
        console.error(`[reconciliacao] não consegui listar as cobranças ${status}:`, r.motivo);
        break;
      }

      const cobrancas = (corpo as { data?: AsaasPayment[] }).data ?? [];
      for (const pay of cobrancas) {
        await aplicarCobrancaPaga(pay, status, r);
      }

      const temMais = Boolean((corpo as { hasMore?: boolean }).hasMore);
      if (!temMais) break;
      if (pagina === MAX_PAGINAS_RECONCILIACAO - 1) r.truncada = true;
    }
  }

  if (r.liberadas > 0 || r.truncada) await avisarSobreReconciliacao(r);
  return r;
}

/**
 * Aplica UMA cobrança paga que o Asaas listou, se ela for inédita aqui.
 *
 * ── O critério de "inédita" é QUALQUER registro, não só o aprovado ────────────
 * Bastaria procurar pagamento APROVADO para saber se o acesso foi liberado — mas aí a
 * cobrança que entrou e virou CASO (dinheiro sem dono identificável, cobrança recebida
 * depois do cancelamento) seria reprocessada em toda varredura, e o alerta dela sairia
 * todo dia até alguém resolver. Alerta repetido é alerta ignorado. Existir linha de
 * pagamento com esse id significa "este dinheiro já foi visto e tratado" — liberando
 * acesso ou abrindo um caso —, e é essa a pergunta certa aqui.
 */
async function aplicarCobrancaPaga(
  pay: AsaasPayment,
  status: string,
  r: ResultadoReconciliacao,
): Promise<void> {
  if (!pay.id) return;
  r.consultadas++;

  /**
   * ⚠️ A consulta de "já vista" fica DENTRO do try, e não antes dele.
   *
   * Ela estava fora, e isso deixava a garantia de isolamento com um buraco do tamanho
   * dela: um tropeço do banco nessa única leitura — conexão derrubada, timeout — derrubava
   * a varredura INTEIRA, e todas as cobranças seguintes, de outros clientes, deixavam de
   * ser aplicadas. Proteger só a parte que "parece perigosa" é como o buraco aparece.
   */
  try {
    const conhecida = await prisma.payment.findFirst({ where: { externalId: pay.id }, select: { id: true } });
    if (conhecida) {
      r.jaConhecidas++;
      return;
    }

    const evento = eventoDoStatus(status);
    const resultado = await processAsaasEvent({ event: evento, payment: pay });

    if (resultado.action === "aprovado") {
      r.liberadas++;
      /**
       * Registro próprio, separado do que o caminho comum grava: é o que permite responder
       * "o webhook está entregando?" olhando a auditoria. Sem ele, pagamento recuperado
       * ficaria indistinguível de pagamento entregue normalmente, e o defeito de entrega
       * seguiria invisível justamente porque a reconciliação o esconde bem.
       */
      await logAudit({
        action: ACAO_PAGAMENTO_RECUPERADO,
        entityType: "Payment",
        entityId: pay.id,
        metadata: {
          evento,
          statusNoAsaas: status,
          valorCents: typeof pay.value === "number" ? Math.round(pay.value * 100) : null,
          recorrencia: pay.subscription ?? null,
          resultado: resultado.message,
        },
      });
    } else {
      r.semLiberacao++;
    }
  } catch (err) {
    /**
     * Uma cobrança que explode não pode parar a varredura: as outras são de outros
     * clientes, e cada uma que deixa de ser aplicada é alguém sem o que pagou.
     */
    r.semLiberacao++;
    console.error(`[reconciliacao] falha ao aplicar a cobrança ${pay.id}:`, (err as Error).message);
  }
}

/** Recuperar pagamento é boa notícia e sintoma ruim: o webhook não entregou. */
async function avisarSobreReconciliacao(r: ResultadoReconciliacao): Promise<void> {
  const linhas: string[] = [];
  if (r.liberadas > 0) {
    linhas.push(
      `${r.liberadas} pagamento(s) confirmado(s) no Asaas não tinham registro aqui e foram aplicados agora.`,
      "O acesso desses clientes está liberado — mas o webhook NÃO entregou esses eventos.",
      `Conferidas ${r.consultadas} cobrança(s) pagas no período; ${r.jaConhecidas} já estavam registradas.`,
    );
  }
  if (r.truncada) {
    linhas.push(
      "ATENÇÃO: havia mais páginas de cobrança do que o teto da varredura, então este resultado" +
        " NÃO é o quadro completo — pode haver mais pagamento sem registro.",
    );
  }

  await alertarOperacao({
    tipo: "asaas_pagamento_recuperado",
    assunto:
      r.liberadas > 0
        ? `${r.liberadas} pagamento(s) liberado(s) pela reconciliação — o webhook não entregou`
        : "A reconciliação de pagamentos não pôde varrer o período inteiro",
    linhas,
    acao:
      "Confira o webhook no painel do Asaas: URL ({APP_URL}/api/webhooks/asaas), token igual nos dois" +
      " lados, e a fila de sincronização da conta — ela para no primeiro evento que falha e não entrega" +
      " nenhum posterior. Enquanto ela estiver travada, esta varredura é o que segura o produto.",
    metadata: { source: "reconciliacao", ...r },
  });
}

export async function encerrarBoletosVencidos(
  agora: Date = new Date(),
): Promise<{ encerradas: number; recorrenciasNaoCanceladas: number; adiadas: number }> {
  const vencidas = await prisma.subscription.findMany({
    where: {
      status: "INADIMPLENTE",
      canceledReason: MOTIVO_BOLETO_VENCIDO,
      graceUntil: { lt: agora },
    },
    select: { id: true, externalRef: true, organizationId: true },
  });

  let recorrenciasNaoCanceladas = 0;
  let encerradas = 0;
  let adiadas = 0;

  for (const sub of vencidas) {
    /**
     * ⚠️ CONFERIR NO PROVEDOR ANTES DO PASSO IRREVERSÍVEL.
     *
     * As duas escritas abaixo não têm volta: a assinatura é encerrada e a recorrência é
     * APAGADA no Asaas. Até aqui isso era decidido só pelo relógio do nosso banco. Se o
     * webhook de pagamento se perdeu, atrasou além da janela ou falhou ao ser processado,
     * o cliente que PAGOU perdia o acesso e a recorrência — e nada no sistema sabia que
     * havia dinheiro dele lá.
     *
     * Duas saídas sem encerrar, e as duas são adiamento, não desistência:
     *  - cobrança PAGA no provedor: o dinheiro entrou e o evento não chegou. Quem libera
     *    é o webhook (ou o painel, à mão) — não esta rotina, porque período, créditos e
     *    registro de pagamento são contrato dele, e fazer isso em dois lugares é como as
     *    duas versões divergem.
     *  - consulta que FALHOU: informação faltando não autoriza passo irreversível.
     */
    const consulta = await cobrancaPagaNoProvedor(sub.externalRef);

    if (consulta.paga || consulta.falhou) {
      adiadas++;
      const motivo = consulta.paga
        ? "há cobrança paga no Asaas — o pagamento não chegou a ser processado aqui"
        : `não foi possível conferir as cobranças no Asaas (${consulta.motivo ?? "erro desconhecido"})`;

      await logAudit({
        action: "subscription.boleto_vencido_adiado",
        entityType: "Subscription",
        entityId: sub.id,
        metadata: { motivo, assinaturaAsaas: sub.externalRef, statusNoAsaas: consulta.statusVistos ?? null },
      });

      /**
       * Só o caso do pagamento vira alerta. Consulta que falha é adiada e tentada de novo
       * amanhã sozinha; cliente que pagou e está sem acesso não se resolve esperando.
       */
      if (consulta.paga) {
        const dono = await donoDa(sub as unknown as Subscription);
        await alertarOperacao({
          tipo: "asaas_boleto_pago_sem_liberacao",
          assunto: "Boleto PAGO no Asaas e acesso não liberado",
          linhas: [
            `Cliente: ${dono?.email ?? "não identificado"}.`,
            `Assinatura: ${sub.id} (recorrência: ${sub.externalRef ?? "-"}).`,
            `Situação das cobranças no Asaas: ${(consulta.statusVistos ?? []).join(", ") || "-"}.`,
            "O encerramento por boleto vencido foi ADIADO: a assinatura não foi cancelada e a recorrência não foi apagada.",
          ],
          acao:
            "Confira a cobrança no painel do Asaas e libere o ciclo à mão (painel → assinaturas)." +
            " O cliente pagou e está sem acesso.",
          metadata: { subscriptionId: sub.id, assinatura: sub.externalRef, statusNoAsaas: consulta.statusVistos ?? null },
        });
      }
      continue;
    }

    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: "CANCELADA", canceledAt: agora },
    });

    const falhou = await cancelarRecorrencia(sub.externalRef, {
      tipoEvento: "asaas_boleto_vencido_recorrencia_ativa",
      contexto: { motivo: "boleto_vencido", subscriptionId: sub.id, organizacao: sub.organizationId },
    });
    if (falhou) recorrenciasNaoCanceladas++;
    encerradas++;

    await logAudit({
      action: "subscription.canceled_boleto_vencido",
      entityType: "Subscription",
      entityId: sub.id,
      metadata: {
        recorrenciaCancelada: !falhou,
        assinaturaAsaas: sub.externalRef,
        conferidoNoProvedor: true,
        statusNoAsaas: consulta.statusVistos ?? null,
      },
    });
  }

  return { encerradas, recorrenciasNaoCanceladas, adiadas };
}

/**
 * Contratação por BOLETO.
 *
 * ── Por que não passa pelo Checkout ───────────────────────────────────────────
 * O Checkout hospedado do Asaas não aceita boleto: `billingTypes` admite apenas
 * CREDIT_CARD e PIX (docs.asaas.com/reference/create-new-checkout). Boleto só
 * existe na API de Assinaturas, que exige um `customer` já criado — e criar
 * cliente exige `name` e `cpfCnpj` (docs.asaas.com/reference/create-new-customer).
 *
 * Consequência prática: aqui SOMOS NÓS que coletamos o CPF/CNPJ, papel que o
 * Checkout cumpria nos outros métodos. O documento é gravado criptografado
 * (`User.documentEnc`, AES-256-GCM) porque é dado pessoal sob a LGPD, e o valor em
 * claro só transita para o provedor.
 *
 * ── A vantagem que compensa o trabalho ───────────────────────────────────────
 * A API de Assinaturas aceita `externalReference`. Ou seja: no boleto o vínculo
 * com a conta viaja no próprio evento, e não depende da tabela de sessões de
 * checkout que o cartão precisou. É o caminho mais robusto dos três.
 */
export interface ContratacaoBoleto {
  userId: string;
  nome: string;
  email: string;
  /** CPF ou CNPJ, só dígitos. Validado antes de chegar aqui. */
  cpfCnpj: string;
  planoSlug: string;
  planoNome: string;
  valorCents: number;
  /** MENSAL vira MONTHLY; ANUAL vira YEARLY. */
  cycle: "MONTHLY" | "YEARLY";
}

export interface ResultadoBoleto {
  assinaturaId: string;
  /** Link do boleto para o cliente pagar. */
  boletoUrl: string | null;
  /** Fatura do Asaas, com boleto e linha digitável. */
  faturaUrl: string | null;
  vencimento: string | null;
}

export async function criarAssinaturaBoleto(dados: ContratacaoBoleto): Promise<ResultadoBoleto> {
  const valor = Number((dados.valorCents / 100).toFixed(2));

  /**
   * O cliente do Asaas é criado com `externalReference` = id da nossa conta.
   * O Asaas reaproveita cliente com o mesmo CPF, e a referência é o que permite
   * reconhecê-lo depois sem depender do documento — que é dado sensível e não
   * queremos consultar por ele.
   */
  const cliente = await asaasFetch("/customers", {
    method: "POST",
    body: JSON.stringify({
      name: dados.nome,
      email: dados.email,
      cpfCnpj: dados.cpfCnpj,
      externalReference: `user:${dados.userId}`,
      notificationDisabled: false,
    }),
  });
  const clienteId = (cliente as { id?: string }).id;
  if (!clienteId) throw new AsaasError("Asaas não devolveu o id do cliente.", 502, cliente);

  const assinatura = await asaasFetch("/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      customer: clienteId,
      billingType: "BOLETO",
      value: valor,
      // Primeiro vencimento hoje: o acesso é liberado quando o boleto é PAGO, e o
      // cliente escolhe quando pagar dentro do prazo do banco.
      nextDueDate: hojeISO(),
      cycle: dados.cycle,
      description: dados.planoNome,
      // É esta linha que faz o webhook saber de quem é o dinheiro.
      externalReference: `plano:${dados.planoSlug}:user:${dados.userId}`,
    }),
  });
  const assinaturaId = (assinatura as { id?: string }).id;
  if (!assinaturaId) throw new AsaasError("Asaas não devolveu o id da assinatura.", 502, assinatura);

  /**
   * O boleto não vem na resposta da assinatura — é preciso listar as cobranças
   * dela. Falha aqui NÃO invalida a contratação: a assinatura existe e o Asaas
   * envia o boleto por e-mail. O cliente vê a mensagem de que o boleto chegará por
   * e-mail em vez de uma tela de erro sobre algo que deu certo.
   */
  let boletoUrl: string | null = null;
  let faturaUrl: string | null = null;
  let vencimento: string | null = null;
  try {
    const cobrancas = await asaasFetch(`/subscriptions/${encodeURIComponent(assinaturaId)}/payments`, {
      method: "GET",
    });
    const primeira = (cobrancas as { data?: Array<Record<string, unknown>> }).data?.[0];
    if (primeira) {
      boletoUrl = (primeira.bankSlipUrl as string | undefined) ?? null;
      faturaUrl = (primeira.invoiceUrl as string | undefined) ?? null;
      vencimento = (primeira.dueDate as string | undefined) ?? null;
    }
  } catch (err) {
    console.error(
      `[asaas] assinatura ${assinaturaId} criada, mas não consegui listar o boleto:`,
      (err as Error).message,
    );
  }

  return { assinaturaId, boletoUrl, faturaUrl, vencimento };
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export function verifyAsaasToken(header: string | null): boolean {
  const esperado = env.asaas.webhookToken;
  if (!esperado) return false; // sem token configurado, recusa por segurança
  if (!header) return false;
  return safeEqual(header, esperado);
}

/**
 * Campos que o Asaas manda como NULL, não como ausentes.
 *
 * A distinção não é preciosismo de tipo: a interface antes declarava
 * `externalReference?: string`, o provedor mandou `null` na primeira cobrança
 * recorrente, e o código foi escrito acreditando na interface em vez de no
 * payload. Modelar o `null` é o que faz o compilador cobrar o tratamento.
 */
interface AsaasPayment {
  /**
   * Campos que o Asaas manda e nós não usamos, declarados de propósito.
   *
   * Manter a interface fiel ao corpo real permite escrever o teste com o payload
   * copiado do painel, sem recortes. Interface que só declara o que convém foi
   * como o defeito de identificação do pagamento passou por 26 testes.
   */
  object?: string | null;
  paymentLink?: string | null;

  id?: string;
  customer?: string | null;
  subscription?: string | null;
  /**
   * Sessão de checkout que originou a cobrança.
   *
   * Confirmado no payload real: o Asaas manda este campo NO PAGAMENTO. É o
   * caminho mais curto para saber de quem é o dinheiro — dispensa consultar a
   * assinatura e funciona também na cobrança avulsa, que não tem assinatura.
   */
  checkoutSession?: string | null;
  value?: number | null;
  billingType?: string | null;
  status?: string | null;
  /**
   * Vencimento da cobrança (AAAA-MM-DD).
   *
   * É a âncora da janela de compensação do boleto. Declarado opcional porque o
   * comportamento antigo — contar da chegada do evento — continua sendo o recuo quando
   * o campo não vem: melhor um prazo aproximado que nenhum. Ver `handleStatus`.
   */
  dueDate?: string | null;
  externalReference?: string | null;
}
interface AsaasWebhook {
  /** Id do evento e data — enviados pelo Asaas, declarados para o corpo real caber inteiro. */
  id?: string;
  dateCreated?: string;
  event?: string;
  payment?: AsaasPayment;
}

type Acao = "aprovado" | "atraso" | "estorno" | "cancelado" | "ignorado";

export interface ProcessResult {
  action: Acao;
  userId?: string;
  message: string;
}

function classificar(event: string): Acao {
  const e = event.toUpperCase();
  if (["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"].includes(e)) return "aprovado";
  if (["PAYMENT_OVERDUE"].includes(e)) return "atraso";
  if (
    ["PAYMENT_REFUNDED", "PAYMENT_PARTIALLY_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED", "PAYMENT_CHARGEBACK_DISPUTE"].includes(e)
  )
    return "estorno";
  if (["PAYMENT_DELETED"].includes(e)) return "cancelado";
  return "ignorado";
}

/**
 * `upgrade:` é a cobrança AVULSA da diferença proporcional gerada pela tela
 * "mudar plano" — distinta de `plano:`, que é a contratação recorrente cheia. Ler
 * um upgrade como contratação nova reiniciaria o ciclo pago e criaria uma segunda
 * recorrência.
 */
function parseRef(ref?: string | null): { tipo: "plano" | "pacote" | "upgrade"; slug: string; userId: string } | null {
  if (!ref) return null;
  const m = ref.match(/^(plano|pacote|upgrade):(.+):user:(.+)$/);
  if (!m) return null;
  return { tipo: m[1] as "plano" | "pacote" | "upgrade", slug: m[2]!, userId: m[3]! };
}

export async function processAsaasEvent(payload: AsaasWebhook): Promise<ProcessResult> {
  const event = String(payload.event ?? "UNKNOWN");
  const pay = payload.payment;
  if (!pay?.id) {
    await logSecurityEvent({ type: "webhook_invalid", metadata: { source: "asaas", reason: "sem_payment_id", event } });
    return { action: "ignorado", message: "Evento sem pagamento identificável." };
  }

  const acao = classificar(event);
  switch (acao) {
    case "aprovado":
      return handleAprovado(pay, event);
    case "atraso":
      return handleStatus(pay, "INADIMPLENTE", "atraso", event);
    case "estorno":
      return handleEstorno(pay, event);
    case "cancelado":
      return handleCancelado(pay);
    default:
      return { action: "ignorado", message: `Evento ${event} sem ação mapeada.` };
  }
}

/**
 * Recupera a referência da conta na ASSINATURA do Asaas.
 *
 * ── O defeito que isto conserta (visto em produção, 01/08/2026) ───────────────
 * Numa cobrança RECORRENTE, o Asaas guarda o `externalReference` na assinatura e
 * manda os pagamentos dela com `externalReference: null`. O payload real da
 * primeira cobrança paga foi exatamente este:
 *
 *   { "event": "PAYMENT_CONFIRMED",
 *     "payment": { "id": "pay_...", "status": "CONFIRMED", "value": 39.9,
 *                  "subscription": "sub_...", "externalReference": null } }
 *
 * O código presumia que a primeira cobrança traria a referência. Sem ela, não
 * havia como saber de quem era o dinheiro: o evento caía em "assinatura não
 * vinculada" e a função devolvia 200. O Asaas considerava entregue e nunca
 * reenviava — cliente pagou, nada foi liberado, e o único rastro era um
 * securityEvent que ninguém estava olhando.
 *
 * Nenhum teste pegou isso porque os payloads de teste eram fabricados por mim
 * COM `externalReference` na primeira cobrança: a suposição errada estava
 * também no teste. A correção vem acompanhada de um caso com o payload real.
 *
 * Falhar aqui devolve `null` e o chamador segue para o caminho de renovação, que
 * registra o evento como não vinculado — nunca deixa o pagamento sumir calado.
 */
type RefDaCompra = { tipo: "plano" | "pacote" | "upgrade"; slug: string; userId: string };

/**
 * Traduz uma sessão de checkout no que foi comprado e por quem.
 *
 * Esta é a tabela que `criarCheckout` alimenta. O id da sessão é nosso, então o
 * vínculo não depende de o provedor devolver dado algum.
 */
async function refDaSessaoDeCheckout(sessao: string): Promise<RefDaCompra | null> {
  const registro = await prisma.asaasCheckout.findUnique({ where: { id: sessao } });
  if (!registro) return null;
  return { tipo: registro.tipo as RefDaCompra["tipo"], slug: registro.slug, userId: registro.userId };
}

async function refDaAssinaturaAsaas(
  assinaturaId: string,
): Promise<{ tipo: "plano" | "pacote" | "upgrade"; slug: string; userId: string } | null> {
  let assinatura: { externalReference?: string | null; checkoutSession?: string | null; customer?: string | null };
  try {
    assinatura = await asaasFetch(`/subscriptions/${encodeURIComponent(assinaturaId)}`, { method: "GET" });
  } catch (err) {
    console.error(`[asaas] não foi possível ler a assinatura ${assinaturaId}:`, (err as Error).message);
    return null;
  }

  // 1) Se por acaso a referência estiver lá, ela é a fonte mais direta.
  const doProvedor = parseRef(assinatura.externalReference);
  if (doProvedor) return doProvedor;

  /**
   * 2) O caminho que de fato funciona: a sessão de checkout.
   *
   * Foi verificado na API que `externalReference` vem NULO na assinatura criada
   * pelo checkout — o Asaas não propaga o campo. O que ele traz é
   * `checkoutSession`, o id da sessão que nós criamos e gravamos em
   * `AsaasCheckout` (ver `criarCheckout`). Este é o vínculo determinístico.
   */
  const sessao = assinatura.checkoutSession;
  if (sessao) {
    const registro = await refDaSessaoDeCheckout(sessao);
    if (registro) return registro;
    console.error(
      `[asaas] assinatura ${assinaturaId} veio da sessão ${sessao}, que não está registrada aqui.` +
        ` Provavelmente é checkout criado antes desta gravação existir.`,
    );
  }

  /**
   * NÃO há passo 3 por e-mail do pagador, de propósito.
   *
   * No primeiro pagamento real o e-mail digitado no formulário do Asaas foi
   * diferente do e-mail da conta que comprou — e o endereço digitado pertencia a
   * uma conta apagada no mesmo dia. Casar por e-mail teria creditado a conta
   * errada, o que é pior que não creditar: dinheiro de um cliente virando acesso
   * de outro. O `customer` fica registrado abaixo apenas como pista para o
   * suporte resolver à mão.
   */
  await logSecurityEvent({
    type: "asaas_pagamento_sem_vinculo",
    metadata: {
      source: "asaas",
      assinatura: assinaturaId,
      checkoutSession: sessao ?? null,
      customerAsaas: assinatura.customer ?? null,
    },
  });
  return null;
}

// ---------------------------------------------------------------------------
// Dinheiro que o sistema não pode aplicar
// ---------------------------------------------------------------------------

/**
 * Pagamento que entrou e não tem a quem ser aplicado.
 *
 * ── O defeito que isto conserta ───────────────────────────────────────────────
 * Havia OITO saídas em que um pagamento APROVADO era descartado: conta do
 * `externalReference` inexistente, plano ou pacote apagado, assinatura do Asaas sem
 * vínculo local, evento sem referência nenhuma, upgrade ou crédito avulso pagos por
 * quem não tem assinatura. Todas devolviam 200 ao Asaas com `ignorado` e, na melhor
 * das hipóteses, uma linha em `SecurityEvent`.
 *
 * O efeito era sempre o mesmo: o dinheiro saiu da conta do cliente, não virou
 * acesso, não virou devolução, e não existia em lugar nenhum do nosso sistema. Nem
 * na lista de pagamentos, nem em chamado, nem em e-mail. Descobrir dependia de
 * alguém conferir o extrato do Asaas linha por linha contra o banco — e foi
 * exatamente o que aconteceu no primeiro pagamento real do produto.
 *
 * ── O que muda ────────────────────────────────────────────────────────────────
 * 1. A quantia é GRAVADA, com `subscriptionId` nulo: passa a existir, a aparecer no
 *    painel e a poder ser conferida contra o extrato do provedor.
 * 2. Um alerta sai por e-mail para quem opera, com o id da cobrança, o valor e o
 *    motivo — informação suficiente para devolver ou aplicar à mão.
 *
 * ── Por que `PENDENTE` e não `APROVADO` ───────────────────────────────────────
 * `APROVADO` significa, em todo o resto do sistema, "pagamento que entregou o que
 * foi comprado": entra em receita e é o que a checagem de evento repetido procura.
 * Esta quantia entrou no provedor e não entregou nada. `PENDENTE` é o que ela é —
 * dinheiro à espera de identificação — e mantém a receita honesta.
 *
 * ── Por que continua devolvendo 200 ───────────────────────────────────────────
 * Erro faria o Asaas reenviar o evento em laço, e o reenvio não conserta nada: o
 * vínculo que falta não vem no evento. Quem resolve é gente, e é a gente que o
 * alerta acorda.
 */
/**
 * A assinatura para a qual este dinheiro iria tem um PEDIDO DE PARADA em vigor?
 *
 * Devolve a assinatura quando sim — e nulo quando não há pedido, ou quando o
 * pagamento é uma contratação NOVA de quem havia pedido para parar (aí ele volta
 * porque quis, e ativar é o certo).
 *
 * Procura pelos dois caminhos que o webhook usa, na mesma ordem: pela CONTA, quando o
 * evento traz referência (é por aqui que entram boleto, upgrade e crédito avulso), e
 * pela RECORRÊNCIA, quando não traz.
 */
async function assinaturaComPedidoDeParada(
  refUserId: string | null,
  pay: AsaasPayment,
): Promise<Subscription | null> {
  let sub: Subscription | null = null;

  if (refUserId) {
    const org = await prisma.organization.findFirst({ where: { ownerId: refUserId } });
    if (org) {
      sub = await prisma.subscription.findFirst({
        where: { organizationId: org.id },
        orderBy: { createdAt: "desc" },
      });
    }
  }
  if (!sub && pay.subscription) {
    sub = await prisma.subscription.findFirst({ where: { externalRef: pay.subscription } });
  }

  if (!sub || !canceladaAPedido(sub)) return null;
  return (await ehContratacaoNova(sub, pay)) ? null : sub;
}

async function dinheiroSemDestino(
  pay: AsaasPayment,
  amountCents: number,
  motivo: string,
  contexto: Record<string, unknown>,
): Promise<ProcessResult> {
  /**
   * O par CONFIRMED→RECEIVED do cartão traz o MESMO pagamento duas vezes. Gravar é
   * idempotente por (externalId + status), mas o alerta não é: sem esta checagem
   * quem opera receberia dois e-mails por cobrança órfã e aprenderia a ignorá-los.
   */
  const jaRegistrado = pay.id
    ? await prisma.payment.findFirst({ where: { externalId: pay.id, status: "PENDENTE" } })
    : null;

  if (!jaRegistrado) {
    await recordPayment(null, pay.id ?? "", "PENDENTE", amountCents, pay.billingType ?? null, null);
    await alertarOperacao({
      tipo: "asaas_dinheiro_sem_destino",
      assunto: `Pagamento de ${emReais(amountCents)} entrou sem conta identificada`,
      linhas: [
        `Motivo: ${motivo}.`,
        `Cobrança no Asaas: ${pay.id ?? "sem id"}.`,
        `Valor: ${emReais(amountCents)}.`,
        `Forma de pagamento: ${pay.billingType ?? "não informada"}.`,
        ...Object.entries(contexto).map(([k, v]) => `${k}: ${v ?? "-"}`),
        "A quantia foi registrada como PENDENTE e NÃO liberou acesso a ninguém.",
      ],
      acao:
        "Abra a cobrança no painel do Asaas, identifique o pagador e então libere o acesso à mão" +
        " (painel → assinaturas) ou devolva a quantia. Enquanto isso, quem pagou está sem serviço.",
      metadata: { source: "asaas", paymentId: pay.id ?? null, valorCents: amountCents, motivo, ...contexto },
    });
  }

  return {
    action: "ignorado",
    message: `Pagamento sem destino (${motivo}). Registrado como PENDENTE e encaminhado à operação.`,
  };
}

/**
 * Cobrança que chegou DEPOIS de a assinatura ter sido cancelada a pedido.
 *
 * ── O defeito que isto conserta ───────────────────────────────────────────────
 * O caminho de renovação gravava `status: "ATIVA"` sem olhar por que a assinatura
 * estava cancelada. Combinado com o cancelamento do painel, que não falava com o
 * Asaas, o resultado era um laço fechado: o admin cancelava, o cartão continuava
 * sendo debitado todo mês, e cada débito RESSUSCITAVA a assinatura — inclusive
 * liberando os 20 créditos do ciclo, o que dá ao erro a aparência de serviço
 * contratado. O cliente que pediu para parar via a cobrança no extrato e a
 * assinatura ativa na tela.
 *
 * ── O que se faz com o dinheiro ───────────────────────────────────────────────
 * Não se aplica e não se devolve automaticamente. Devolver é ato irreversível sobre
 * dinheiro de terceiro e tem de ser decidido por gente; o que o sistema faz é tornar
 * o caso impossível de passar em branco: grava a cobrança como PENDENTE ligada à
 * assinatura, avisa a operação com o passo a passo, e avisa o CLIENTE.
 *
 * O aviso ao cliente é a parte que evita o pior desfecho. Sem ele, o caminho natural
 * de quem vê cobrança após cancelar é contestar no cartão — e a contestação dispara
 * `handleEstorno`, que põe a conta em ESTORNADA, bloqueia o saldo e derruba o acesso
 * de um cliente que não fez nada de errado.
 */
async function cobrancaDepoisDoCancelamento(
  sub: Subscription,
  pay: AsaasPayment,
  amountCents: number,
  repetido: boolean,
): Promise<ProcessResult> {
  /**
   * Cobrança que JÁ foi aprovada antes do cancelamento não é indevida.
   *
   * O par do cartão são dois eventos do mesmo débito, separados por dias: o
   * PAYMENT_CONFIRMED da aprovação e o PAYMENT_RECEIVED da liquidação. Se o cliente
   * cancelar entre um e outro, o segundo chega aqui — e sem esta saída o sistema
   * gravaria como "a devolver" uma receita legítima, já aplicada, e mandaria a
   * operação devolver dinheiro que o cliente comprou e usou.
   */
  if (repetido) {
    return {
      action: "ignorado",
      message: "Liquidação de cobrança aprovada ANTES do cancelamento: nada a fazer.",
    };
  }

  /**
   * O mesmo par, agora com os dois eventos DEPOIS do cancelamento: o registro é
   * idempotente por (externalId + status), mas o alerta e o e-mail ao cliente não.
   * Dois avisos do mesmo débito ensinam a ignorar o aviso — e é o cliente que recebe
   * duas vezes "vamos devolver".
   */
  const jaAvisado = pay.id
    ? await prisma.payment.findFirst({ where: { externalId: pay.id, status: "PENDENTE" } })
    : null;
  if (jaAvisado) {
    return {
      action: "ignorado",
      message: "Cobrança após o cancelamento já registrada para devolução (evento repetido).",
    };
  }

  await recordPayment(sub.id, pay.id!, "PENDENTE", amountCents, pay.billingType ?? null, null);

  const dono = await donoDa(sub);
  let avisoCliente: string | undefined;

  {
    await alertarOperacao({
      tipo: "asaas_cobranca_apos_cancelamento",
      assunto: `Cobrança de ${emReais(amountCents)} recebida DEPOIS do cancelamento`,
      linhas: [
        `Cliente: ${dono?.email ?? "não identificado"}.`,
        `Assinatura: ${sub.id} (recorrência no Asaas: ${sub.externalRef ?? "-"}).`,
        `Cancelada em ${sub.canceledAt?.toLocaleDateString("pt-BR") ?? "-"} — motivo: ${sub.canceledReason ?? "-"}.`,
        `Cobrança no Asaas: ${pay.id ?? "sem id"}, ${emReais(amountCents)}.`,
        "A assinatura NÃO foi reativada e nenhum crédito foi liberado.",
      ],
      acao:
        "Devolva a quantia no painel do Asaas e confirme que a recorrência está encerrada lá." +
        " O cliente já foi avisado de que a cobrança não gerou acesso e será devolvida.",
      metadata: {
        source: "asaas",
        subscriptionId: sub.id,
        assinatura: sub.externalRef,
        paymentId: pay.id ?? null,
        valorCents: amountCents,
        motivoDoCancelamento: sub.canceledReason,
      },
    });

    if (dono) {
      avisoCliente = await notificar("cobranca_indevida", dono.id, () =>
        sendUndueCharge({ email: dono.email, name: dono.name }, amountCents),
      );
    }
  }

  await logAudit({
    action: "asaas.cobranca_apos_cancelamento",
    entityType: "Subscription",
    entityId: sub.id,
    metadata: { paymentId: pay.id ?? null, valorCents: amountCents, motivoDoCancelamento: sub.canceledReason },
  });

  return {
    action: "ignorado",
    userId: dono?.id,
    message: comAviso(
      `Cobrança recebida após o cancelamento: a assinatura NÃO foi reativada e a quantia ficou` +
        ` registrada como PENDENTE para devolução.`,
      avisoCliente,
    ),
  };
}

async function handleAprovado(pay: AsaasPayment, event: string): Promise<ProcessResult> {
  const amountCents = typeof pay.value === "number" ? Math.round(pay.value * 100) : 0;

  /**
   * A referência pode vir NO PAGAMENTO ou apenas NA ASSINATURA.
   *
   * Cobrança avulsa (pacote, upgrade) traz no pagamento. A primeira cobrança de
   * uma assinatura recorrente NÃO traz — ver `refDaAssinaturaAsaas`. A consulta
   * extra só acontece quando a assinatura ainda não está vinculada aqui, ou seja,
   * uma vez por cliente: renovação já encontra o vínculo local e não gasta
   * chamada de API.
   */
  let ref = parseRef(pay.externalReference);

  /**
   * A sessão de checkout vem NO PRÓPRIO PAGAMENTO — confirmado no payload real:
   *
   *   "payment": { ..., "subscription": "sub_...", "checkoutSession": "9d4e2b7c-...",
   *                "externalReference": null }
   *
   * Ler daqui dispensa a consulta à assinatura e cobre também a cobrança avulsa
   * (pacote, upgrade), que não tem assinatura nenhuma.
   */
  if (!ref && pay.checkoutSession) {
    ref = await refDaSessaoDeCheckout(pay.checkoutSession);
  }

  // Recuo: assinaturas antigas, ou payload sem o campo acima.
  if (!ref && pay.subscription) {
    const jaVinculada = await prisma.subscription.findFirst({ where: { externalRef: pay.subscription } });
    if (!jaVinculada) ref = await refDaAssinaturaAsaas(pay.subscription);
  }

  /**
   * Este pagamento já foi processado antes?
   *
   * O Asaas manda DOIS eventos por cobrança no cartão — PAYMENT_CONFIRMED na
   * aprovação e PAYMENT_RECEIVED na liquidação — com o MESMO id de pagamento, e
   * reenvia o webhook quando não recebe 200. Tudo o que mexe em saldo aqui é
   * idempotente, mas e-mail não é: sem esta checagem o cliente receberia o mesmo
   * aviso duas vezes em cada compra no cartão.
   */
  const repetido = pay.id
    ? Boolean(await prisma.payment.findFirst({ where: { externalId: pay.id, status: "APROVADO" } }))
    : false;

  /**
   * ⚠️ PEDIDO DE PARADA — decidido AQUI, uma vez, antes de qualquer escrita.
   *
   * A primeira versão desta garantia ficava dentro do Caminho 2, e isso a deixava
   * quase inútil: o BOLETO sempre entra pelo Caminho 1 (a assinatura criada na API
   * leva `externalReference`, que viaja em toda cobrança dela), e o PAYMENT_RECEIVED
   * do cartão — a liquidação, que chega dias depois — também, porque traz a sessão de
   * checkout. Nos dois casos a execução caía em `ativarAssinatura`, que gravava ATIVA
   * e ZERAVA `canceledAt`/`canceledReason`: além de ressuscitar a assinatura de quem
   * pediu para parar, apagava o rastro que faria a próxima cobrança ser barrada.
   *
   * Também cobre upgrade e crédito avulso, que liam a última assinatura da conta sem
   * olhar estado nenhum — um upgrade pago depois do cancelamento reescrevia
   * `nextRenewalAt` um ano à frente e rearmava a cobrança no Asaas.
   */
  const parada = await assinaturaComPedidoDeParada(ref?.userId ?? null, pay);
  if (parada) return cobrancaDepoisDoCancelamento(parada, pay, amountCents, repetido);

  // Caminho 1 — primeira compra: a referência diz a conta e o que foi comprado.
  if (ref) {
    const user = await prisma.user.findUnique({ where: { id: ref.userId } });
    if (!user) {
      return dinheiroSemDestino(pay, amountCents, "a conta do externalReference não existe mais", {
        referencia: `${ref.tipo}:${ref.slug}:user:${ref.userId}`,
      });
    }

    if (ref.tipo === "pacote") return creditarPacoteAsaas(user.id, ref.slug, pay, amountCents);
    if (ref.tipo === "upgrade") return upgradePago(user, ref.slug, pay, amountCents, repetido);

    const plan = await prisma.plan.findUnique({ where: { slug: ref.slug } });
    if (!plan) {
      return dinheiroSemDestino(pay, amountCents, `o plano ${ref.slug} não existe no catálogo`, {
        cliente: user.email,
      });
    }
    const org = await obterOuCriarOrg(user.id, user.name);

    /**
     * Assinatura ATIVA em OUTRO plano significa TROCA de plano, não contratação
     * nova, e precisa de tratamento próprio — ver `trocarPlano`. Sem esta
     * bifurcação, o upgrade caía na ativação comum e o cliente pagava o plano
     * maior sem receber a cota maior.
     */
    const atual = await prisma.subscription.findFirst({
      where: { organizationId: org.id },
      orderBy: { createdAt: "desc" },
    });
    if (atual && atual.status === "ATIVA" && atual.planId !== plan.id) {
      return trocarPlano(atual, plan, pay, amountCents, user, repetido);
    }

    const sub = await ativarAssinatura(org.id, plan, pay, amountCents, repetido);
    await liberarCreditosDoCiclo(sub.id, {
      creditos: plan.monthlyAnalyses,
      descricao: `Créditos liberados pela assinatura do plano ${plan.name}`,
      // O ciclo é o PAGAMENTO: cada cobrança paga compra um ciclo, mesmo que duas
      // caiam no mesmo mês civil. Ver `liberarCreditosDoCiclo`.
      ciclo: `pag:${pay.id}`,
    });
    await logAudit({ action: "asaas.subscription.activated", entityType: "Subscription", entityId: sub.id, metadata: { plan: plan.slug, event } });
    const aviso = repetido
      ? undefined
      : await notificar("ativacao", user.id, () =>
          sendActivated({ email: user.email, name: user.name }, amountCents || plan.priceCents),
        );
    return { action: "aprovado", userId: user.id, message: comAviso("Assinatura ativada.", aviso) };
  }

  // Caminho 2 — renovação: sem externalReference, mas com o id da assinatura Asaas.
  if (pay.subscription) {
    const sub = await prisma.subscription.findFirst({ where: { externalRef: pay.subscription } });
    if (!sub) {
      return dinheiroSemDestino(pay, amountCents, "a recorrência do Asaas não está vinculada a nenhuma conta aqui", {
        recorrenciaAsaas: pay.subscription,
      });
    }

    /**
     * O pedido de parada já foi decidido no topo de `handleAprovado`, para os DOIS
     * caminhos — era estar aqui, e só aqui, que deixava o boleto e a liquidação do
     * cartão passarem por fora da garantia. Ver `assinaturaComPedidoDeParada`.
     */

    // Antes de atualizar: quem estava suspenso recebe "reativada", não "renovada".
    const estavaInativa = sub.status !== "ATIVA";

    /**
     * ⚠️ PAGAR NÃO DESFAZ SUSPENSÃO ADMINISTRATIVA — decisão do dono do negócio.
     *
     * SUSPENSA é gravada por uma única via: a ação do administrador no painel. É sanção
     * sobre o ACESSO — medida de uso aceitável, pendência em apuração — e não encerramento
     * do contrato. O pagamento reativava a conta sozinho, o que transformava a sanção em
     * algo que o próprio sancionado desfazia: bastava o débito do mês seguinte entrar.
     *
     * O que o dinheiro faz, então? O que ele comprou: ESTENDE o período pago e libera a
     * cota do ciclo. Suspensão bloqueia o uso, não confisca o que foi pago — e a Política
     * não autoriza ficar com o dinheiro sem preservar o período. O acesso volta por decisão
     * de quem suspendeu (painel → Restabelecer acesso).
     *
     * E ninguém fica no escuro: o cliente recebe um aviso dizendo que o pagamento entrou,
     * que o período está preservado e com quem falar; a operação recebe alerta, porque
     * cliente suspenso PAGANDO é situação que não pode durar — ou a suspensão sai, ou a
     * cobrança para.
     */
    const suspensaPorDecisao = sub.status === "SUSPENSA";

    /**
     * Boleto pago DEPOIS do encerramento: a recorrência não existe mais.
     *
     * O encerramento por boleto vencido apaga a recorrência no Asaas — é o certo, senão o
     * provedor seguiria emitindo boleto para quem perdeu o acesso. Mas o dinheiro pode
     * chegar depois (compensação lenta, segunda via paga com atraso), e aí a reativação
     * abaixo devolve o acesso deste ciclo e mais nada: não há recorrência para cobrar o
     * ciclo seguinte, e a assinatura pararia sozinha em silêncio, sem que ninguém
     * soubesse — nem o cliente, que acabou de pagar, nem nós.
     *
     * Recriar a recorrência exige o CPF/CNPJ, que é dado pessoal guardado criptografado, e
     * uma cobrança nova no provedor. É ato sobre dinheiro de cliente com decisão de
     * negócio embutida (qual vencimento, qual valor), então quem decide é gente.
     */
    const recorrenciaFoiApagada = sub.status === "CANCELADA" && sub.canceledReason === MOTIVO_BOLETO_VENCIDO;

    /**
     * Ciclo novo pago é o momento em que o downgrade agendado passa a valer.
     * Precisa vir ANTES de ler o plano e de liberar a cota, senão a liberação
     * sairia com a cota do plano antigo — e o cliente pagaria o plano menor
     * recebendo os créditos do maior.
     */
    const agendado = await aplicarPlanoAgendado(sub.id, { valorPagoCents: amountCents });
    const planId = agendado.aplicado
      ? (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id }, select: { planId: true } })).planId
      : sub.planId;

    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    /**
     * Renovação ESTENDE o período a partir do fim já pago. Somar a partir de agora
     * apagava os dias restantes de quem renovava antes do vencimento — e no reenvio
     * do mesmo pagamento somaria um mês de brinde.
     *
     * Com o downgrade ADIADO, `plan` é o plano ANTIGO — de propósito: o período tem de
     * ser o do dinheiro que entrou. Era aqui que o cliente pagava R$ 419,00 do anual e
     * recebia trinta dias.
     */
    const fim =
      repetido && sub.currentPeriodEnd ? sub.currentPeriodEnd : computePeriodEnd(plan?.period, sub.currentPeriodEnd);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        // O período e a cobrança seguem em qualquer caso: o dinheiro entrou.
        currentPeriodEnd: fim,
        // Este caminho é a RENOVAÇÃO de uma assinatura do Asaas: por definição
        // renova de novo, então a próxima data é preenchida.
        nextRenewalAt: fim,
        graceUntil: null,
        // Downgrade adiado passa a valer no fim do período que ACABOU de ser pago.
        // Sem mover a data, a tentativa se repetiria a cada renovação, sempre tarde.
        ...(agendado.adiado ? { pendingPlanAt: fim } : {}),
        // O ACESSO só volta quando não há suspensão administrativa em vigor.
        ...(suspensaPorDecisao
          ? {}
          : { status: "ATIVA", suspendedAt: null, ...(estavaInativa ? { reactivatedAt: new Date() } : {}) }),
      },
    });

    /**
     * Downgrade adiado: reprograma a recorrência AGORA e avisa a operação.
     *
     * A tentativa nova é o que faz o caso se resolver sozinho no ciclo seguinte, em vez
     * de repetir o erro para sempre. E o alerta existe porque o cliente pagou um valor
     * que ele não pediu: só uma pessoa pode decidir devolver a diferença.
     */
    if (recorrenciaFoiApagada && !repetido) {
      const dono = await donoDa(sub);
      await alertarOperacao({
        tipo: "asaas_boleto_pago_apos_encerramento",
        assunto: `Boleto pago DEPOIS do encerramento: recorrência precisa ser recriada`,
        linhas: [
          `Cliente: ${dono?.email ?? "não identificado"}.`,
          `Assinatura: ${sub.id} (recorrência anterior: ${sub.externalRef ?? "-"}).`,
          `Pagamento: ${pay.id ?? "sem id"}, ${emReais(amountCents)}.`,
          `O acesso foi restabelecido e vale até ${fim.toLocaleDateString("pt-BR")}.`,
          "A recorrência havia sido apagada no Asaas ao encerrar por boleto vencido: NÃO há cobrança para o ciclo seguinte.",
        ],
        acao:
          "Combine com o cliente e recrie a assinatura de boleto no Asaas (ou peça que ele contrate de novo pelo site)." +
          " Sem isso, o acesso dele para no fim deste ciclo sem aviso nenhum.",
        metadata: {
          source: "asaas",
          subscriptionId: sub.id,
          assinatura: sub.externalRef,
          pagamento: pay.id ?? null,
          acessoAte: fim,
        },
      });
    }

    if (agendado.adiado && !repetido) {
      const alvo = await prisma.plan.findUnique({ where: { slug: agendado.planoNovo! } });
      const falhou = alvo ? await atualizarValorDaRecorrencia(sub.externalRef, alvo, fim) : "plano agendado não encontrado";
      await alertarOperacao({
        tipo: "asaas_downgrade_cobrado_no_plano_antigo",
        assunto: `Renovação cobrada no plano ANTIGO (${emReais(amountCents)}) com downgrade agendado`,
        linhas: [
          `Cliente: ${(await donoDa(sub))?.email ?? "não identificado"}.`,
          `Plano pedido: ${agendado.planoNovo} (${emReais(agendado.valorEsperadoCents ?? 0)}).`,
          `Cobrado: ${emReais(amountCents)} — o valor do plano ${agendado.planoAnterior}.`,
          `A recorrência no Asaas não estava reprogramada (${sub.externalRef ?? "-"}).`,
          `O cliente recebeu o período que pagou; a troca de plano vale a partir de ${fim.toLocaleDateString("pt-BR")}.`,
          falhou ? `A reprogramação agora TAMBÉM falhou: ${falhou}.` : "A recorrência acabou de ser reprogramada.",
        ],
        acao:
          "Confirme o valor da recorrência no painel do Asaas e ofereça ao cliente a devolução da diferença —" +
          " ele pediu o plano menor e foi cobrado no maior.",
        metadata: {
          source: "asaas",
          subscriptionId: sub.id,
          assinatura: sub.externalRef,
          pagamento: pay.id ?? null,
          valorPagoCents: amountCents,
          valorEsperadoCents: agendado.valorEsperadoCents ?? null,
          reprogramacaoFalhou: falhou ?? null,
        },
      });
    }
    await recordPayment(sub.id, pay.id!, "APROVADO", amountCents, pay.billingType ?? null, new Date());
    await liberarCreditosDoCiclo(sub.id, {
      creditos: plan?.monthlyAnalyses ?? 0,
      descricao: `Créditos liberados pela renovação do plano ${plan?.name ?? "-"}`,
      ciclo: `pag:${pay.id}`,
    });
    const dono = await donoDa(sub);
    let aviso: string | undefined;
    if (dono && !repetido) {
      aviso = suspensaPorDecisao
        ? await notificar("pagamento_suspenso", dono.id, () =>
            sendPaymentWhileSuspended({ email: dono.email, name: dono.name }, fim),
          )
        : estavaInativa
          ? await notificar("reativacao", dono.id, () => sendReactivated({ email: dono.email, name: dono.name }))
          : await notificar("renovacao", dono.id, () =>
              sendRenewalConfirmed({ email: dono.email, name: dono.name }, amountCents || sub.amountCents, fim),
            );
    }

    if (suspensaPorDecisao && !repetido) {
      await alertarOperacao({
        tipo: "asaas_pagamento_de_assinatura_suspensa",
        assunto: `Cliente com acesso SUSPENSO acaba de pagar ${emReais(amountCents || sub.amountCents)}`,
        linhas: [
          `Cliente: ${dono?.email ?? "não identificado"}.`,
          `Assinatura: ${sub.id} (recorrência: ${sub.externalRef ?? "-"}).`,
          `Suspensa desde ${sub.suspendedAt?.toLocaleDateString("pt-BR") ?? "-"}.`,
          `O período pago foi estendido até ${fim.toLocaleDateString("pt-BR")} e a cota do ciclo foi liberada.`,
          "O acesso continua bloqueado: pagar não desfaz suspensão administrativa.",
        ],
        acao:
          "Decida: resolva a pendência e restabeleça o acesso (painel → Restabelecer acesso), ou interrompa a" +
          " cobrança (painel → Interromper cobrança). Cliente suspenso pagando todo mês não pode durar.",
        metadata: {
          source: "asaas",
          subscriptionId: sub.id,
          assinatura: sub.externalRef,
          pagamento: pay.id ?? null,
          valorCents: amountCents || sub.amountCents,
        },
      });
    }

    return {
      action: "aprovado",
      userId: dono?.id,
      message: comAviso(
        suspensaPorDecisao
          ? "Pagamento registrado e período estendido. O acesso segue SUSPENSO: pagar não desfaz suspensão administrativa."
          : "Renovação processada.",
        aviso,
      ),
    };
  }

  return dinheiroSemDestino(pay, amountCents, "o evento não trouxe externalReference nem assinatura vinculável", {
    clienteAsaas: pay.customer ?? null,
    sessaoDeCheckout: pay.checkoutSession ?? null,
  });
}

/**
 * Diferença proporcional do upgrade, paga pela tela "mudar plano".
 *
 * Diferente de `plano:`, esta cobrança é AVULSA e cobre apenas os dias que faltam
 * do ciclo já pago. Por isso aqui NÃO se mexe em `currentPeriodEnd` nem se cria
 * assinatura: o ciclo continua o mesmo, só o plano sobe. O que muda para o futuro
 * é o valor da recorrência já existente — ver `atualizarValorDaRecorrencia`.
 */
async function upgradePago(
  user: { id: string; email: string; name: string },
  slug: string,
  pay: AsaasPayment,
  amountCents: number,
  repetido: boolean,
): Promise<ProcessResult> {
  const novo = await prisma.plan.findUnique({ where: { slug } });
  if (!novo) {
    return dinheiroSemDestino(pay, amountCents, `o plano ${slug} do upgrade não existe no catálogo`, {
      cliente: user.email,
    });
  }

  const org = await prisma.organization.findFirst({ where: { ownerId: user.id } });
  const sub = org
    ? await prisma.subscription.findFirst({ where: { organizationId: org.id }, orderBy: { createdAt: "desc" } })
    : null;
  if (!sub) {
    // Upgrade pressupõe assinatura. Pagamento sem destino não pode ser descartado
    // em silêncio: é dinheiro do cliente já debitado.
    return dinheiroSemDestino(pay, amountCents, "upgrade pago por quem não tem assinatura", {
      cliente: user.email,
      planoPretendido: slug,
    });
  }

  const pagamento = await recordPayment(sub.id, pay.id!, "APROVADO", amountCents, pay.billingType ?? null, new Date());

  /**
   * MUDANÇA DE PERIODICIDADE começa um ciclo NOVO, e isso faltava aqui.
   *
   * `aplicarUpgrade` só move `currentPeriodEnd` quando recebe `novoCicloAte` — e este
   * chamador nunca informava. Resultado no upgrade de mensal para anual: o cliente
   * pagava a diferença proporcional de um ANO e o período pago continuava terminando
   * no fim do MÊS. Duas consequências, ambas caras: no fim do mês a assinatura era
   * tratada como vencida, e a próxima cobrança da recorrência era alinhada a essa data
   * errada — cobrando o valor anual a um mês de distância.
   *
   * O ciclo novo é contado de AGORA, porque é agora que o ano contratado começa. Fora
   * da mudança de periodicidade fica nulo: numa troca de faixa dentro do mesmo período
   * o ciclo é o mesmo, e mexer nele daria ao cliente tempo que ele não comprou.
   */
  const anterior = await prisma.plan.findUnique({ where: { id: sub.planId }, select: { period: true } });
  const mudaPeriodo = (novo.period ?? null) !== (anterior?.period ?? null);
  const novoCicloAte = mudaPeriodo ? computePeriodEnd(novo.period) : null;

  const r = await aplicarUpgrade(sub.id, novo.id, {
    chaveIdempotencia: `upgrade-asaas:${pay.id}`,
    motivo: `Upgrade proporcional pago (${pay.id})`,
    atorId: user.id,
    paymentId: pagamento?.id ?? null,
    novoCicloAte,
  });

  /**
   * A recorrência passa a cobrar o valor E a periodicidade do plano novo; senão o
   * cliente usaria o plano maior pagando o menor todos os meses — ou, na troca para o
   * anual, pagaria o anual todo mês. A próxima cobrança é alinhada ao fim do período
   * que o upgrade acabou de comprar.
   */
  const depoisDoUpgrade = await prisma.subscription.findUnique({
    where: { id: sub.id },
    select: { currentPeriodEnd: true },
  });
  const recorrenciaDesatualizada = await atualizarValorDaRecorrencia(
    sub.externalRef,
    novo,
    depoisDoUpgrade?.currentPeriodEnd ?? null,
  );

  const aviso = repetido
    ? undefined
    : await notificar("upgrade", user.id, () =>
        sendActivated({ email: user.email, name: user.name }, novo.priceCents),
      );

  const base = r.aplicado
    ? `Upgrade para ${novo.name} aplicado (+${r.creditosAdicionais} crédito(s) no ciclo).`
    : "Upgrade já havia sido aplicado (idempotência).";
  const alerta = recorrenciaDesatualizada
    ? ` ATENÇÃO: a recorrência ${sub.externalRef} continua no valor antigo no Asaas — corrija no painel.`
    : "";
  return { action: "aprovado", userId: user.id, message: comAviso(base, aviso) + alerta };
}

/**
 * Põe a cobrança recorrente no valor do plano novo, após um upgrade.
 *
 * Sem isto o upgrade vazaria receita para sempre: o cliente pagaria a diferença
 * proporcional uma vez e seguiria sendo cobrado pelo plano ANTIGO em todas as
 * renovações, usando o plano novo.
 *
 * Falhar não desfaz o upgrade — o dinheiro entrou e a cota já subiu. Mas fica
 * registrado com o id da recorrência, porque é uma correção que alguém precisa
 * fazer à mão no painel.
 */
/**
 * Põe a recorrência do Asaas no plano novo: valor, descrição E PERIODICIDADE.
 *
 * Serve aos dois sentidos da troca. No UPGRADE é chamada na hora, porque o plano
 * novo já vale. No DOWNGRADE é chamada no AGENDAMENTO, com `proximaCobranca` no fim do
 * período já pago — e é isso que faz a cobrança da renovação chegar no valor certo.
 * Ver `agendarDowngrade`, e a rota /api/assinatura/mudar-plano que costura as duas.
 *
 * ── O ciclo era esquecido, e isso cobrava doze vezes ──────────────────────────
 * A função enviava só `value` e `description`. Num upgrade de MENSAL para ANUAL, a
 * recorrência ficava `cycle: MONTHLY` com o valor do anual: o cliente pagava a
 * diferença proporcional uma vez e passava a ser cobrado em R$ 419,00 TODO MÊS. Sem
 * a periodicidade, "atualizar o valor" produzia a pior cobrança possível.
 *
 * `nextDueDate` também vai, alinhado ao fim do período que o cliente acabou de
 * comprar: sem isso, a recorrência anual continuaria cobrando na data do ciclo mensal
 * antigo — daqui a poucos dias, e não daqui a um ano.
 */
export async function atualizarValorDaRecorrencia(
  externalRef: string | null,
  novo: { name: string; priceCents: number; period: string | null },
  proximaCobranca?: Date | null,
): Promise<string | undefined> {
  if (!externalRef) return undefined;
  try {
    await asaasFetch(`/subscriptions/${encodeURIComponent(externalRef)}`, {
      method: "PUT",
      body: JSON.stringify({
        value: Number((novo.priceCents / 100).toFixed(2)),
        description: novo.name,
        cycle: novo.period === "ANUAL" ? "YEARLY" : "MONTHLY",
        ...(proximaCobranca ? { nextDueDate: proximaCobranca.toISOString().slice(0, 10) } : {}),
        // A cobrança em aberto do ciclo atual não deve ser alterada: ela já foi
        // paga pelo plano antigo, e a diferença veio na cobrança avulsa.
        updatePendingPayments: false,
      }),
    });
    return undefined;
  } catch (err) {
    const motivo = (err as Error).message;
    console.error(`[asaas] a recorrência ${externalRef} NÃO foi atualizada para ${novo.name}:`, motivo);
    await logSecurityEvent({
      type: "asaas_recorrencia_desatualizada",
      metadata: { source: "asaas", assinatura: externalRef, planoNovo: novo.name, valorCents: novo.priceCents, erro: motivo },
    });
    return motivo;
  }
}

async function creditarPacoteAsaas(userId: string, slug: string, pay: AsaasPayment, amountCents: number): Promise<ProcessResult> {
  const pack = await prisma.creditPack.findUnique({ where: { slug } });
  if (!pack) {
    return dinheiroSemDestino(pay, amountCents, `o pacote de créditos ${slug} não existe no catálogo`, {
      contaId: userId,
    });
  }

  const org = await prisma.organization.findFirst({ where: { ownerId: userId } });
  const sub = org ? await prisma.subscription.findFirst({ where: { organizationId: org.id }, orderBy: { createdAt: "desc" } }) : null;
  if (!sub) {
    // Crédito avulso pressupõe assinatura: é onde o saldo mora.
    return dinheiroSemDestino(pay, amountCents, "crédito avulso comprado por quem não tem assinatura", {
      contaId: userId,
      pacote: slug,
    });
  }

  const payment = await recordPayment(sub.id, pay.id!, "APROVADO", amountCents, pay.billingType ?? null, new Date());
  const r = await creditarPacote(sub.id, pack.credits, {
    validadeDias: pack.validityDays,
    paymentId: payment?.id ?? null,
    idempotencyKey: `pacote-asaas:${pay.id}`,
    descricao: `${pack.name}, validade de ${pack.validityDays} dias`,
  });
  return {
    action: "aprovado",
    userId,
    message: r.jaCreditado ? "Pacote já creditado (idempotência)." : `${pack.credits} crédito(s) adicionado(s).`,
  };
}

/**
 * Troca de plano comprada pelo checkout.
 *
 * O bug que isto conserta: a troca caía na ativação comum, que chama
 * `liberarCreditosDoCiclo`. Essa liberação é idempotente pelo MÊS — proteção
 * correta contra webhook repetido, mas aqui virava armadilha. Quem assinava o
 * Essencial (2 créditos) e subia para o Profissional (8) na mesma semana tinha o
 * `planId` trocado, pagava R$ 119,90 e continuava com cota 2 até o mês seguinte,
 * porque a chave do ciclo já existia. Pagou pelo plano maior, recebeu o menor, e
 * nada no sistema acusava.
 *
 * O critério:
 *  - upgrade  → vale na hora, complementando a cota com a DIFERENÇA, sem zerar o
 *               consumo (quem gastou 1 de 2 e sobe para 8 fica com 7 disponíveis);
 *  - downgrade→ é AGENDADO. O mês em curso foi pago no plano maior, então a cota
 *               não cai no meio do caminho; o plano menor passa a valer na
 *               renovação (pendingPlanId).
 */
async function trocarPlano(
  atual: Subscription,
  novo: Plan,
  pay: AsaasPayment,
  amountCents: number,
  user: { id: string; email: string; name: string },
  repetido: boolean,
): Promise<ProcessResult> {
  const anterior = await prisma.plan.findUnique({ where: { id: atual.planId } });
  const valor = amountCents || novo.priceCents;
  /**
   * ⚠️ Subir de plano é pagar MAIS — e aqui a pergunta era feita pela COTA.
   *
   * `novo.monthlyAnalyses >= anterior.monthlyAnalyses` funcionava por acidente, enquanto
   * os planos tinham cotas diferentes. A oferta atual são dois planos com a MESMA cota
   * (20 análises/mês) em duas periodicidades: a comparação passou a responder sempre
   * "é upgrade", e o ramo de upgrade RECOMEÇA o período. Quem tinha o anual pago até
   * agosto e comprava o mensal pela página de planos perdia onze meses de serviço já
   * pago num clique. O critério agora é único para todo o sistema — ver `ehSubidaDePlano`.
   */
  const ehUpgrade = ehSubidaDePlano(anterior ?? { priceCents: 0 }, novo);
  const refAnterior = atual.externalRef;
  const novaRef = pay.subscription ?? pay.id!;

  await recordPayment(atual.id, pay.id!, "APROVADO", valor, pay.billingType ?? null, new Date());

  if (ehUpgrade) {
    // A troca de plano em si (cota + auditoria + idempotência) é a mesma operação
    // usada pela tela "mudar plano"; aqui só se acrescenta o que é do checkout:
    // novo ciclo pago e novo id de recorrência.
    await aplicarUpgrade(atual.id, novo.id, {
      chaveIdempotencia: `troca-asaas:${pay.id}`,
      motivo: `Troca de plano pelo checkout (${pay.id})`,
      atorId: user.id,
    });
    /**
     * O período é ESTENDIDO a partir do fim já pago, não recomeçado em hoje.
     *
     * Sem a base, o upgrade apagava os dias restantes do ciclo anterior — dias que o
     * cliente já havia pago. Ver `computePeriodEnd`: a partida é o que estiver mais à
     * frente entre o fim pago e agora.
     */
    const fim = computePeriodEnd(novo.period, atual.currentPeriodEnd);
    await prisma.subscription.update({
      where: { id: atual.id },
      data: { amountCents: valor, externalRef: novaRef, currentPeriodEnd: fim, nextRenewalAt: fim },
    });
  } else {
    /**
     * DOWNGRADE comprado pela página de planos (não pela tela "mudar plano").
     *
     * Aqui o cliente PAGOU um ciclo do plano menor enquanto o período do plano maior
     * ainda corria — e nada disso era tratado:
     *
     *  1. O ciclo pago sumia. `currentPeriodEnd` não se movia, então o dinheiro que
     *     entrou não comprava tempo nenhum: quem tinha o anual até agosto pagava
     *     R$ 49,90 e continuava até agosto. Agora o período é estendido por um ciclo do
     *     plano novo, que é exatamente o que foi comprado.
     *
     *  2. A recorrência NOVA (criada pelo checkout) cobraria de novo um ciclo a partir de
     *     HOJE, dentro de um período que o cliente já tinha pago no plano anterior:
     *     cobrança dupla, todo mês, até o fim do período antigo. `nextDueDate` é alinhada
     *     ao fim do período pago.
     *
     * O plano só troca em `pendingPlanAt` — o fim do período que o plano MAIOR pagou —,
     * porque até ali a cota maior foi comprada e é entregue.
     */
    const fimEstendido =
      repetido && atual.currentPeriodEnd
        ? atual.currentPeriodEnd
        : computePeriodEnd(novo.period, atual.currentPeriodEnd);

    await prisma.subscription.update({
      where: { id: atual.id },
      data: {
        pendingPlanId: novo.id,
        pendingPlanAt: atual.currentPeriodEnd,
        externalRef: novaRef,
        currentPeriodEnd: fimEstendido,
        nextRenewalAt: fimEstendido,
      },
    });

    // A recorrência nova só cobra quando o tempo já pago terminar.
    await atualizarValorDaRecorrencia(novaRef, novo, fimEstendido);
  }

  const assinaturaAntigaAtiva = await cancelarAssinaturaAnterior(refAnterior, novaRef);

  await logAudit({
    action: ehUpgrade ? "asaas.subscription.upgrade" : "asaas.subscription.downgrade_scheduled",
    entityType: "Subscription",
    entityId: atual.id,
    metadata: {
      de: anterior?.slug,
      para: novo.slug,
      valorCents: valor,
      assinaturaAsaasAnterior: refAnterior,
      assinaturaAsaasAtual: novaRef,
      // Quando o cancelamento da cobrança anterior falha, isto é o que evita a
      // cobrança dupla passar em branco.
      cancelamentoAnteriorPendente: assinaturaAntigaAtiva ?? false,
    },
  });

  const aviso = repetido
    ? undefined
    : await notificar(ehUpgrade ? "upgrade" : "downgrade", user.id, () =>
        sendActivated({ email: user.email, name: user.name }, valor),
      );

  const base = ehUpgrade
    ? `Upgrade para ${novo.name} aplicado.`
    : `Downgrade para ${novo.name} agendado para o fim do período pago.`;
  const alerta = assinaturaAntigaAtiva
    ? ` ATENÇÃO: a cobrança anterior (${refAnterior}) não foi cancelada no Asaas e pode cobrar de novo — cancele no painel.`
    : "";
  return { action: "aprovado", userId: user.id, message: comAviso(base, aviso) + alerta };
}

/**
 * Manda o Asaas parar de cobrar uma recorrência.
 *
 * É a única forma de interromper cobrança de fato: marcar a assinatura como
 * CANCELADA no nosso banco não fala com o gateway, e o cartão do cliente continua
 * sendo debitado todo mês. Cobrança depois do cancelamento é cobrança indevida, e
 * o cliente percebe no extrato antes de nós.
 *
 * Devolve `undefined` quando deu certo, ou o motivo da falha. Nunca lança: quem
 * chama já executou a parte irreversível (troca de plano paga, cancelamento
 * pedido pelo cliente) e não pode ser derrubado por indisponibilidade do
 * provedor. A falha vira registro de segurança com o id da recorrência, porque
 * alguém precisa cancelar à mão no painel.
 *
 * Cobrança ÚNICA (PIX) sai daqui como sucesso, e é a resposta correta: não existe
 * recorrência, então não há nada a interromper — ver `ehRecorrencia`.
 */
export async function cancelarRecorrencia(
  externalRef: string | null,
  opcoes: { tipoEvento: string; contexto?: Record<string, unknown> },
): Promise<string | undefined> {
  if (!externalRef || !ehRecorrencia(externalRef)) return undefined;
  try {
    await asaasFetch(`/subscriptions/${encodeURIComponent(externalRef)}`, { method: "DELETE" });
    return undefined;
  } catch (err) {
    const motivo = (err as Error).message;
    console.error(`[asaas] a recorrência ${externalRef} NÃO foi cancelada:`, motivo);
    await logSecurityEvent({
      type: opcoes.tipoEvento,
      metadata: { source: "asaas", assinatura: externalRef, erro: motivo, ...(opcoes.contexto ?? {}) },
    });
    return motivo;
  }
}

/**
 * Cancela a recorrência ANTERIOR na troca de plano.
 *
 * O checkout hospedado cria uma assinatura NOVA a cada compra e a antiga continua
 * cobrando: sem isto, quem troca de plano passa a pagar as DUAS.
 */
async function cancelarAssinaturaAnterior(
  refAnterior: string | null,
  novaRef: string,
): Promise<string | undefined> {
  if (!refAnterior || refAnterior === novaRef) return undefined;
  return cancelarRecorrencia(refAnterior, {
    tipoEvento: "asaas_cobranca_anterior_ativa",
    contexto: { motivo: "troca_de_plano", assinaturaAtual: novaRef },
  });
}

/**
 * A cobrança deste evento pertence a OUTRA recorrência, e não à assinatura encontrada?
 *
 * ── O defeito que isto conserta ───────────────────────────────────────────────
 * `acharSub` procura a assinatura por dois caminhos, e o primeiro é largo: pela
 * referência da compra chega à conta, e da conta pega a assinatura MAIS RECENTE — qualquer
 * que seja a recorrência dela. Serve para o caso comum, e erra feio quando a conta tem
 * mais de uma contratação na vida.
 *
 * O caminho concreto: o cliente tem assinatura paga por PIX (ciclo único, `externalRef`
 * com id de PAGAMENTO) e contrata boleto. A contratação por boleto cria a recorrência no
 * Asaas e NÃO cria assinatura aqui — a nossa só nasce quando o pagamento é confirmado. Ele
 * desiste e não paga. O boleto vence, o Asaas manda PAYMENT_OVERDUE, e o evento daquela
 * recorrência abandonada cai sobre a assinatura de PIX que está em dia: INADIMPLENTE, com
 * motivo de boleto vencido — e a manutenção diária a encerra dias depois.
 *
 * O cliente perde a assinatura que PAGOU por causa de uma cobrança que ele não pagou, de
 * outra contratação. Com PAYMENT_DELETED é pior: o cancelamento é imediato.
 *
 * O teste é objetivo: o evento traz o id da recorrência (`pay.subscription`), e a
 * assinatura local guarda em `externalRef` a recorrência que é dela. Diferentes, a cobrança
 * é de outra contratação. `externalRef` nulo (liberação manual) não permite comparar, então
 * ali o comportamento antigo é mantido.
 */
function ehDeOutraRecorrencia(sub: Subscription, pay: AsaasPayment): boolean {
  if (!pay.subscription || !ehRecorrencia(pay.subscription)) return false;
  if (!sub.externalRef) return false;
  return pay.subscription !== sub.externalRef;
}

/** Ação de auditoria da contratação abandonada — também é o registro que evita repetir o alerta. */
const ACAO_CONTRATACAO_ABANDONADA = "asaas.contratacao_sem_assinatura_local";

/**
 * Cobrança de uma contratação que nunca virou assinatura aqui.
 *
 * É o retrato do boleto abandonado: a contratação cria a recorrência no Asaas, a nossa
 * assinatura só nasce no pagamento confirmado, e quem desiste deixa uma recorrência VIVA no
 * provedor emitindo boleto a cada ciclo — para sempre, sem nada do nosso lado sabendo.
 *
 * Antes, esses eventos eram descartados em silêncio ("Assinatura não encontrada"): a
 * bagunça crescia no provedor e ninguém ficava sabendo. Pior, uma cobrança antiga paga
 * meses depois reativaria a conta sem que ninguém esperasse por isso.
 *
 * Avisa UMA vez por recorrência, não por boleto — senão o alerta se repetiria a cada ciclo
 * vencido e viraria ruído no canal que precisa ser lido.
 */
async function contratacaoSemAssinaturaLocal(
  pay: AsaasPayment,
  event: string,
  motivo: string,
): Promise<ProcessResult> {
  const recorrencia = pay.subscription ?? null;
  let ref = parseRef(pay.externalReference);
  if (!ref && pay.checkoutSession) ref = await refDaSessaoDeCheckout(pay.checkoutSession);
  const user = ref ? await prisma.user.findUnique({ where: { id: ref.userId }, select: { email: true, name: true } }) : null;

  const jaAvisado = recorrencia
    ? await prisma.auditLog.findFirst({
        where: { action: ACAO_CONTRATACAO_ABANDONADA, metadata: { path: ["recorrencia"], equals: recorrencia } },
        select: { id: true },
      })
    : null;

  if (!jaAvisado) {
    await logAudit({
      action: ACAO_CONTRATACAO_ABANDONADA,
      entityType: "Subscription",
      entityId: recorrencia ?? (pay.id ?? "sem-id"),
      metadata: { evento: event, recorrencia, plano: ref?.slug ?? null, conta: ref?.userId ?? null, motivo },
    });

    await alertarOperacao({
      tipo: "asaas_contratacao_abandonada",
      assunto: "Contratação por boleto abandonada: recorrência viva no Asaas",
      linhas: [
        `Cliente: ${user?.email ?? "não identificado"}.`,
        `Recorrência no Asaas: ${recorrencia ?? "-"}.`,
        `Plano pretendido: ${ref?.slug ?? "não identificado"}.`,
        `Evento recebido: ${event} — ${motivo}.`,
        "Nenhuma assinatura foi criada aqui, e NENHUMA assinatura existente foi afetada.",
        "A recorrência continua no provedor e vai emitir cobrança a cada ciclo.",
      ],
      acao:
        "Fale com o cliente: se ele ainda pretende pagar, oriente pela segunda via; se desistiu," +
        " apague a recorrência no painel do Asaas. Deixada viva, ela emite boleto todo ciclo — e uma" +
        " cobrança antiga paga meses depois ativaria a conta sem ninguém esperar.",
      metadata: { source: "asaas", recorrencia, plano: ref?.slug ?? null, conta: ref?.userId ?? null, evento: event },
    });
  }

  return {
    action: "ignorado",
    message:
      `Cobrança de contratação que não virou assinatura aqui (${motivo}).` +
      " Nenhuma assinatura foi afetada; a operação foi avisada da recorrência aberta no provedor.",
  };
}

async function handleStatus(
  pay: AsaasPayment,
  status: SubscriptionStatus,
  acao: Acao,
  /** Nome do evento do provedor, para o registro dizer o que chegou. */
  event: string,
): Promise<ProcessResult> {
  const sub = await acharSub(pay);
  if (!sub) {
    return contratacaoSemAssinaturaLocal(pay, event, "não existe assinatura para esta cobrança");
  }

  /**
   * A cobrança é de OUTRA recorrência? Então não é esta assinatura que está em atraso.
   *
   * Sem esta checagem, o boleto abandonado de uma contratação nova derrubava a assinatura
   * que o cliente tinha PAGA: INADIMPLENTE com motivo de boleto vencido, e encerrada pela
   * manutenção diária dias depois. Ver `ehDeOutraRecorrencia`.
   */
  if (ehDeOutraRecorrencia(sub, pay)) {
    return contratacaoSemAssinaturaLocal(pay, event, "a cobrança é de outra recorrência do Asaas");
  }

  /**
   * Quem pediu para parar não fica INADIMPLENTE.
   *
   * A cobrança venceu porque não devia existir — a recorrência não foi encerrada no
   * Asaas, ou o boleto do ciclo já estava emitido. Marcar de inadimplente quem
   * cancelou é errado em três frentes: acusa o cliente de dever o que ele mandou
   * cancelar, coloca a assinatura no MRR e nos "inadimplentes" do painel, e — o pior —
   * TIRAVA a assinatura do estado CANCELADA, o que desarmava a garantia contra a
   * cobrança seguinte ressuscitá-la. Hoje a garantia lê `canceledByRequestAt` e não
   * depende mais do status, mas escrever aqui continua sendo mentira sobre o cliente.
   */
  if (canceladaAPedido(sub)) {
    return {
      action: "ignorado",
      message: "Cobrança vencida de assinatura já encerrada a pedido: nada a marcar.",
    };
  }

  /**
   * ⚠️ Cobrança AVULSA vencida não suspende a assinatura.
   *
   * O PIX de R$ 5,00 do crédito adicional que o cliente abre e abandona vencia, o Asaas
   * mandava PAYMENT_OVERDUE, e a mensalidade de R$ 49,90 — paga em dia — virava
   * INADIMPLENTE: prazo de tolerância aberto, e-mail de "pagamento atrasado" ao cliente
   * e, passada a tolerância, encerramento pela manutenção diária. Desistir de um
   * acréscimo derrubava o que já estava pago. Ver `tipoDaCobranca`.
   */
  const tipo = await tipoDaCobranca(pay);
  if (ehAvulsa(tipo)) return avulsaNaoAfetaAssinatura(sub, pay, "PAYMENT_OVERDUE", tipo as "pacote" | "upgrade");

  /**
   * O prazo depende da forma de pagamento, porque o motivo do atraso é diferente.
   *
   * CARTÃO: a cobrança falhou (limite, cartão vencido) e o Asaas tenta de novo.
   * Cinco dias de tolerância dão tempo de o cliente resolver, e cortar no mesmo
   * dia castiga quem regulariza em 48 horas.
   *
   * BOLETO: não existe nova tentativa — o boleto simplesmente venceu. A regra do
   * negócio é encerrar. O prazo aqui é apenas a janela de COMPENSAÇÃO bancária:
   * boleto pago no dia do vencimento leva 1 a 3 dias úteis para ser confirmado, e
   * o `PAYMENT_OVERDUE` chega antes disso. Sem essa janela, quem pagou em dia
   * seria cancelado e o dinheiro cairia numa assinatura encerrada.
   */
  const ehBoleto = (pay.billingType ?? "").toUpperCase() === "BOLETO";

  /**
   * A janela do BOLETO é contada em dias ÚTEIS, a partir do VENCIMENTO.
   *
   * Ela existe porque boleto pago no dia do vencimento compensa em 1 a 3 dias ÚTEIS, e
   * o `PAYMENT_OVERDUE` chega antes disso. Contá-la em dias corridos desmonta a própria
   * razão de ser: boleto pago numa sexta compensa na quarta — cinco dias corridos —, e
   * três dias corridos venceriam no domingo, encerrando a assinatura de quem pagou em
   * dia, com o dinheiro a caminho.
   *
   * A âncora é o `dueDate` da cobrança, não o instante em que o evento chega. É o que a
   * Política publica — prazo contado do VENCIMENTO — e a diferença é real: webhook
   * atrasado ou reenviado dias depois esticava a janela na mesma medida do atraso, e o
   * prazo praticado deixava de ser o prazo escrito. Sem `dueDate` no evento, mantém-se o
   * recuo antigo: melhor um prazo aproximado que nenhum.
   */
  const vencimentoDoBoleto = ehBoleto ? dataDoVencimento(pay.dueDate) : null;
  const limite = ehBoleto
    ? somarDiasUteis(vencimentoDoBoleto ?? new Date(), DIAS_COMPENSACAO_BOLETO)
    : new Date(Date.now() + DIAS_TOLERANCIA_INADIMPLENCIA * 86_400_000);

  /**
   * A TOLERÂNCIA NÃO REINICIA a cada cobrança vencida.
   *
   * `graceUntil` era reescrito com "agora + prazo" em todo evento de atraso, e o Asaas
   * manda um por cobrança. Quem nunca pagava ganhava cinco dias novos a cada mês, para
   * sempre: a assinatura nunca era encerrada, seguia contando no MRR do painel e o
   * cliente mantinha os créditos que deveriam ter expirado. E contraria a Política, que
   * publica o prazo contado do VENCIMENTO, não de cada aviso.
   *
   * A janela é a da PRIMEIRA cobrança vencida desta inadimplência: já havendo uma, ela
   * é preservada. Regularizado o pagamento, `graceUntil` é limpo na renovação, e a
   * inadimplência seguinte abre uma janela nova.
   */
  const jaEmAtraso = sub.status === "INADIMPLENTE" && sub.graceUntil !== null;
  const graceUntil = status === "INADIMPLENTE" ? (jaEmAtraso ? sub.graceUntil : limite) : sub.graceUntil;

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status,
      suspendedAt: sub.suspendedAt ?? new Date(),
      graceUntil,
      // Guarda o motivo para a manutenção diária saber que este atraso termina em
      // cancelamento, e não em nova tentativa de cobrança.
      ...(ehBoleto && status === "INADIMPLENTE" ? { canceledReason: MOTIVO_BOLETO_VENCIDO } : {}),
    },
  });
  // Avisar é o que dá ao cliente a chance de regularizar dentro da tolerância —
  // sem e-mail, ele só descobre quando o acesso cai.
  const dono = await donoDa(sub);
  const aviso =
    dono && status === "INADIMPLENTE"
      ? await notificar("atraso", dono.id, () => sendPaymentLate({ email: dono.email, name: dono.name }))
      : undefined;
  return { action: acao, userId: dono?.id, message: comAviso(`Assinatura marcada como ${status}.`, aviso) };
}

/**
 * Estorno de CRÉDITO AVULSO: retira só os créditos daquela compra.
 *
 * A assinatura não é tocada — nem o status, nem a cota do mês, nem o acesso. O que
 * volta é o que aquele pagamento comprou, e apenas na parte ainda não usada: crédito
 * já consumido corresponde a análise já entregue, e cobrar de volta um serviço
 * prestado seria retirar o que o cliente recebeu.
 *
 * Idempotente pela chave, para o reenvio do evento não descontar duas vezes.
 */
async function estornoDePacote(
  sub: Subscription,
  slug: string,
  pay: AsaasPayment,
  event: string,
): Promise<ProcessResult> {
  const pack = await prisma.creditPack.findUnique({ where: { slug } });
  const comprados = pack?.credits ?? 0;
  const chave = `estorno-pacote-asaas:${pay.id}`;

  if (await prisma.creditLedger.findUnique({ where: { idempotencyKey: chave } })) {
    return { action: "estorno", message: "Estorno de crédito avulso já processado." };
  }

  // Só o que ainda está no saldo avulso pode ser retirado.
  const aRetirar = Math.min(comprados, Math.max(0, sub.extraAnalyses));
  const saldoAntes = Math.max(0, sub.analysesQuota - sub.analysesUsed) + Math.max(0, sub.extraAnalyses);

  if (aRetirar > 0) {
    await prisma.$transaction([
      prisma.creditLedger.create({
        data: {
          subscriptionId: sub.id,
          kind: "AJUSTE_ADMIN",
          bucket: "ADICIONAL",
          quantity: -aRetirar,
          balanceBefore: saldoAntes,
          balanceAfter: saldoAntes - aRetirar,
          description: "Créditos avulsos retirados por estorno do pagamento",
          reason: `Estorno (${event}) da compra de crédito avulso`,
          idempotencyKey: chave,
        },
      }),
      prisma.subscription.update({
        where: { id: sub.id },
        data: { extraAnalyses: { decrement: aRetirar } },
      }),
    ]);
  }

  const amountCents = typeof pay.value === "number" ? Math.round(pay.value * 100) : 0;
  await recordPayment(sub.id, pay.id!, "ESTORNADO", amountCents, pay.billingType ?? null, null);
  await logAudit({
    action: "subscription.estorno_credito_avulso",
    entityType: "Subscription",
    entityId: sub.id,
    metadata: { pacote: slug, comprados, retirados: aRetirar, evento: event, pagamento: pay.id },
  });

  const naoRetirados = comprados - aRetirar;
  return {
    action: "estorno",
    message:
      `Estorno de crédito avulso: ${aRetirar} crédito(s) retirado(s)` +
      (naoRetirados > 0 ? `, ${naoRetirados} já consumido(s) e mantido(s)` : "") +
      ". A assinatura não foi afetada.",
  };
}

/**
 * Devolução de uma quantia que estava PENDENTE — o outro lado de `dinheiroSemDestino`.
 *
 * ── O laço que ficava aberto ──────────────────────────────────────────────────
 * Gravar o dinheiro órfão como PENDENTE resolveu metade do problema: ele passou a
 * existir e a aparecer na tela. Faltava a saída. Devolvida a quantia no painel do
 * Asaas, o `PAYMENT_REFUNDED` chegava aqui, não encontrava assinatura nenhuma
 * (dinheiro órfão não tem) e era ignorado — a linha ficava na tela "Dinheiro sem
 * destino" para sempre. Em poucas semanas a tela viraria uma lista de casos velhos e
 * ninguém mais olharia, que é exatamente o defeito que o registro veio consertar.
 *
 * Agora a devolução feita no Asaas fecha o caso sozinha: a mesma linha muda de estado,
 * em vez de virar um segundo registro do mesmo dinheiro.
 */
async function estornoDePendente(pay: AsaasPayment, event: string): Promise<ProcessResult | null> {
  if (!pay.id) return null;
  const pendente = await prisma.payment.findFirst({ where: { externalId: pay.id, status: "PENDENTE" } });
  if (!pendente) return null;

  /**
   * Devolução PARCIAL não encerra o caso, e dizer que encerra seria pior que não
   * tratar: parte do dinheiro voltou e parte continua sendo quantia indevida em
   * poder do fornecedor. A linha fica na tela até alguém concluir.
   */
  if (ehDevolucaoParcial(event)) {
    // Reenvio do mesmo evento não gera segundo alerta: aqui nada muda de estado, então
    // é o registro que garante a idempotência.
    const primeiraVez = await registrarUmaVez("asaas.devolucao_parcial_pendente", "Payment", pendente.id, pay.id, {
      evento: event,
      valorCents: pendente.amountCents,
    });
    if (primeiraVez) {
      await alertarOperacao({
        tipo: "asaas_devolucao_parcial_de_pendente",
        assunto: `Devolução PARCIAL de quantia pendente de ${emReais(pendente.amountCents)}`,
        linhas: [
          `Cobrança no Asaas: ${pay.id}.`,
          `Valor originalmente recebido: ${emReais(pendente.amountCents)}.`,
          "A devolução foi parcial, então o caso NÃO foi encerrado automaticamente.",
        ],
        acao: "Conclua a devolução no painel do Asaas e depois encerre o caso na tela de pendências.",
        metadata: { paymentId: pendente.id, pagamento: pay.id, valorCents: pendente.amountCents },
      });
    }
    return {
      action: "estorno",
      message: "Devolução parcial de quantia pendente: o caso segue aberto, a operação foi avisada.",
    };
  }

  await prisma.payment.update({ where: { id: pendente.id }, data: { status: "ESTORNADO" } });
  await logAudit({
    action: "asaas.pendente_devolvido",
    entityType: "Payment",
    entityId: pendente.id,
    metadata: { evento: event, pagamento: pay.id, valorCents: pendente.amountCents, assinatura: pendente.subscriptionId },
  });

  return {
    action: "estorno",
    message: `Devolução confirmada de ${emReais(pendente.amountCents)} que estava pendente. Caso encerrado.`,
  };
}

/**
 * O evento é de devolução PARCIAL?
 *
 * Vive numa função própria porque a resposta governa quatro caminhos — dinheiro
 * pendente, assinatura, crédito avulso e a leitura do próprio extrato — e a pergunta
 * tem de ser feita do mesmo jeito nos quatro.
 */
function ehDevolucaoParcial(event: string): boolean {
  return event.toUpperCase() === "PAYMENT_PARTIALLY_REFUNDED";
}

/**
 * A cobrança deste evento é AVULSA — crédito adicional ou diferença de upgrade?
 *
 * ── Por que a pergunta existe ─────────────────────────────────────────────────
 * Compra avulsa gera no Asaas uma cobrança SEPARADA, que não é a mensalidade. E os
 * eventos dela chegavam ao mesmo lugar que os eventos da assinatura, com efeito
 * grotesco quando o cliente simplesmente desistia da compra:
 *
 *  - PIX de R$ 5,00 abandonado → `PAYMENT_OVERDUE` → a assinatura de R$ 49,90, paga em
 *    dia, virava INADIMPLENTE, ganhava prazo de tolerância e o cliente recebia
 *    "pagamento atrasado". Passada a tolerância, a manutenção diária encerrava.
 *  - a mesma cobrança apagada no painel do Asaas → `PAYMENT_DELETED` → a assinatura era
 *    CANCELADA, com e-mail de cancelamento ao cliente.
 *
 * Em nenhum dos dois o cliente devia nada: ele desistiu de um acréscimo, e a
 * mensalidade continuava paga. Não pagar o que é opcional não pode derrubar o que já
 * foi pago.
 *
 * ── O sinal, e o seu limite ───────────────────────────────────────────────────
 * A referência da compra, pelos mesmos dois caminhos que a aprovação usa. Não dá para
 * decidir pela ausência de `subscription` no evento — cobrança de PLANO por PIX também
 * é única e chega sem esse campo. Quando a referência não resolve (sessão de checkout
 * anterior ao registro de vínculo), o evento cai no caminho da assinatura, como antes;
 * o tipo fica no registro para o caso ser reconhecível depois.
 */
async function tipoDaCobranca(pay: AsaasPayment): Promise<"plano" | "pacote" | "upgrade" | null> {
  let ref = parseRef(pay.externalReference);
  if (!ref && pay.checkoutSession) ref = await refDaSessaoDeCheckout(pay.checkoutSession);
  return ref?.tipo ?? null;
}

function ehAvulsa(tipo: "plano" | "pacote" | "upgrade" | null): boolean {
  return tipo === "pacote" || tipo === "upgrade";
}

/** Nome da compra avulsa em português, para registro e mensagem. */
function nomeDaAvulsa(tipo: "pacote" | "upgrade"): string {
  return tipo === "pacote" ? "crédito avulso" : "diferença de upgrade";
}

/**
 * Evento de cobrança AVULSA que não deve tocar a assinatura.
 *
 * Registra e sai. Sem e-mail ao cliente de propósito: abandonar um checkout é ato
 * deliberado e comum, e escrever para dizer "você não comprou" transforma uma
 * desistência normal em cobrança de satisfação.
 */
async function avulsaNaoAfetaAssinatura(
  sub: Subscription,
  pay: AsaasPayment,
  event: string,
  tipo: "pacote" | "upgrade",
): Promise<ProcessResult> {
  const nome = nomeDaAvulsa(tipo);
  await registrarUmaVez("asaas.cobranca_avulsa_ignorada", "Subscription", sub.id, pay.id ?? null, {
    evento: event,
    tipoDaCompra: tipo,
    valorCents: typeof pay.value === "number" ? Math.round(pay.value * 100) : null,
    efeito: "assinatura preservada",
  });
  return {
    action: "ignorado",
    message:
      `Evento (${event}) de cobrança de ${nome}: a assinatura NÃO foi afetada.` +
      " A compra avulsa não paga apenas não gera crédito.",
  };
}

/**
 * Registra um fato UMA vez por cobrança, e diz se foi a primeira.
 *
 * O Asaas reenvia evento, e há casos em que o tratamento correto é "não mexer em nada".
 * Sem esta marca, o alerta à operação sairia a cada reenvio — e alerta repetido é
 * alerta ignorado, justamente nos casos que dependem de alguém olhar.
 */
async function registrarUmaVez(
  action: string,
  entityType: "Subscription" | "Payment",
  entityId: string,
  paymentId: string | null,
  metadata: Record<string, unknown>,
): Promise<boolean> {
  if (paymentId) {
    const jaRegistrado = await prisma.auditLog.findFirst({
      where: { action, entityId, metadata: { path: ["pagamento"], equals: paymentId } },
      select: { id: true },
    });
    if (jaRegistrado) return false;
  }
  await logAudit({ action, entityType, entityId, metadata: { ...metadata, pagamento: paymentId } });
  return true;
}

/**
 * Devolução parcial de uma cobrança de assinatura: preserva tudo e chama gente.
 *
 * Não altera status, não bloqueia crédito, não manda e-mail de encerramento ao cliente —
 * nada do que a devolução TOTAL faz, porque nada disso é verdade aqui. O que o sistema
 * pode afirmar é que houve devolução parcial e que ela precisa de conferência humana.
 *
 * O cliente não recebe aviso automático de propósito: o valor devolvido não vem no
 * evento, e mandar "parte do seu pagamento foi devolvida" sem dizer quanto gera mais
 * dúvida do que informação. Quem devolveu sabe o valor e fala com ele.
 */
async function devolucaoParcialDaAssinatura(
  sub: Subscription,
  pay: AsaasPayment,
  event: string,
  /** "plano", "pacote" ou "upgrade" — só para o alerta dizer o que foi comprado. */
  tipoDaCompra: string | null,
): Promise<ProcessResult> {
  const dono = await donoDa(sub);
  const primeiraVez = await registrarUmaVez("asaas.devolucao_parcial", "Subscription", sub.id, pay.id ?? null, {
    evento: event,
    assinatura: sub.externalRef,
    valorDaCobrancaCents: typeof pay.value === "number" ? Math.round(pay.value * 100) : null,
  });

  if (primeiraVez) {
    await alertarOperacao({
      tipo: "asaas_devolucao_parcial_de_assinatura",
      assunto: "Devolução PARCIAL de uma cobrança de assinatura",
      linhas: [
        `Cliente: ${dono?.email ?? "não identificado"}.`,
        `Assinatura: ${sub.id} (recorrência no Asaas: ${sub.externalRef ?? "-"}).`,
        `Cobrança: ${pay.id ?? "sem id"}, valor original ${emReais(typeof pay.value === "number" ? Math.round(pay.value * 100) : sub.amountCents)}.`,
        `Compra: ${tipoDaCompra ?? "não identificada"}.`,
        "O acesso, o status e os créditos do cliente foram PRESERVADOS.",
        "O valor devolvido não vem no evento do provedor — confira no painel do Asaas.",
      ],
      acao:
        tipoDaCompra === "pacote"
          ? "Confirme no Asaas quanto foi devolvido. Se a intenção era desfazer a compra do crédito avulso," +
            " retire o crédito pelo painel (assinaturas → créditos); se era ajuste de valor, nada mais a fazer."
          : "Confirme no Asaas quanto foi devolvido e por quê. Se a intenção era encerrar a assinatura," +
            " cancele-a no painel; se era desconto ou ajuste, não há mais nada a fazer.",
      metadata: {
        source: "asaas",
        subscriptionId: sub.id,
        assinatura: sub.externalRef,
        paymentId: pay.id ?? null,
        evento: event,
      },
    });
  }

  return {
    action: "estorno",
    userId: dono?.id,
    message:
      "Devolução parcial registrada. A assinatura, o acesso e os créditos foram preservados —" +
      " parte do valor continua paga. A operação foi avisada para conferir o valor.",
  };
}

/**
 * Devolução da diferença proporcional de um upgrade.
 *
 * Preserva a assinatura e encaminha à operação. Reverter o upgrade exigiria decidir o
 * que fazer com a cota adicional já liberada (e possivelmente consumida), e essa conta
 * não se faz sem olhar o caso.
 */
async function estornoDeUpgrade(
  sub: Subscription,
  slug: string,
  pay: AsaasPayment,
  event: string,
): Promise<ProcessResult> {
  const dono = await donoDa(sub);
  const valor = typeof pay.value === "number" ? Math.round(pay.value * 100) : 0;

  const primeiraVez = await registrarUmaVez("asaas.estorno_de_upgrade", "Subscription", sub.id, pay.id ?? null, {
    evento: event,
    planoDoUpgrade: slug,
    valorCents: valor,
    efeito: "assinatura preservada, reversão do plano pendente de decisão",
  });

  if (primeiraVez) {
    await alertarOperacao({
      tipo: "asaas_estorno_de_upgrade",
      assunto: `Devolução da diferença de upgrade (${emReais(valor)})`,
      linhas: [
        `Cliente: ${dono?.email ?? "não identificado"}.`,
        `Assinatura: ${sub.id}; plano contratado no upgrade: ${slug}.`,
        `Cobrança devolvida: ${pay.id ?? "sem id"}, ${emReais(valor)}.`,
        "A assinatura, o acesso e os créditos foram PRESERVADOS.",
        "O plano NÃO voltou automaticamente ao anterior.",
      ],
      acao:
        "Decida se o plano deve voltar ao anterior. Se sim, agende o downgrade no painel e" +
        " confira a cota do ciclo — a diferença de créditos do upgrade pode já ter sido usada.",
      metadata: {
        source: "asaas",
        subscriptionId: sub.id,
        planoDoUpgrade: slug,
        paymentId: pay.id ?? null,
        valorCents: valor,
      },
    });
  }

  await recordPayment(sub.id, pay.id!, "ESTORNADO", valor, pay.billingType ?? null, null);

  return {
    action: "estorno",
    userId: dono?.id,
    message:
      "Devolução da diferença de upgrade registrada. A assinatura e os créditos foram preservados;" +
      " a volta ao plano anterior depende de decisão do atendimento.",
  };
}

/** Ação de auditoria do estorno de cobrança de outro contrato — e a marca que evita repetir o alerta. */
const ACAO_ESTORNO_DE_OUTRO_CONTRATO = "asaas.estorno_de_outro_contrato";

/**
 * Devolução de uma cobrança que pertence a OUTRA recorrência, e não ao contrato em vigor.
 *
 * ── O defeito que isto conserta ───────────────────────────────────────────────
 * É o mesmo furo de `acharSub` que derrubava assinatura paga por boleto abandonado, aqui
 * pelo caminho mais destrutivo do sistema. `handleEstorno` era o único dos três usos da
 * busca que ficou sem guarda, e o que ele faz com a assinatura errada é tudo de uma vez:
 * status ESTORNADA (o login passa a ser RECUSADO), todo o saldo bloqueado, a recorrência
 * encerrada no provedor e um e-mail ao cliente dizendo "assinatura encerrada por estorno".
 *
 * O caminho concreto: o cliente pagou por boleto, depois trocou para PIX ou cartão — e
 * `ativarAssinatura` ATUALIZA a assinatura da organização, então o `externalRef` passou a
 * apontar para a contratação nova e a antiga deixou de existir aqui. Meses depois, a
 * devolução de um boleto antigo (cortesia, mês cobrado em duplicidade) ou uma CONTESTAÇÃO
 * daquela cobrança antiga chega ao sistema — `PAYMENT_CHARGEBACK_REQUESTED` também é
 * classificado como estorno — e cai sobre o contrato atual, que está pago e em dia. O
 * cliente é posto fora do ar por causa da devolução de um ciclo que já tinha terminado.
 *
 * ── O que se faz em vez disso ────────────────────────────────────────────────
 * Nada é desfeito, porque nada do que a devolução total afirma é verdade aqui: o contrato
 * em vigor foi pago por outra cobrança, que ninguém devolveu. A devolução é REGISTRADA — o
 * dinheiro voltou de verdade e não pode ficar invisível — e o caso vai para uma pessoa,
 * porque decidir se o acesso atual deve ser afetado depende de saber POR QUE o dinheiro
 * voltou, e isso o evento não diz. Numa contestação a resposta provavelmente é sim; numa
 * cortesia, não.
 *
 * A linha fica pendurada na assinatura de propósito: é a mesma linha local cujo
 * `externalRef` mudou de contratação, o extrato do cliente já mostra aquele pagamento como
 * "Pago", e esconder a devolução deixaria o extrato afirmando que um dinheiro devolvido
 * continua pago. Ela entra como ESTORNADO, que a tela rotula e da qual não deriva estado
 * nenhum — e não vira pendência, porque "dinheiro sem destino" lê só PENDENTE.
 */
async function estornoDeOutroContrato(
  sub: Subscription,
  pay: AsaasPayment,
  event: string,
): Promise<ProcessResult> {
  const valor = typeof pay.value === "number" ? Math.round(pay.value * 100) : 0;
  const dono = await donoDa(sub);

  if (pay.id) await recordPayment(sub.id, pay.id, "ESTORNADO", valor, pay.billingType ?? null, null);

  /**
   * Avisa uma vez por COBRANÇA: o par de eventos de estorno chega duas vezes, e a
   * contestação pode somar um terceiro evento sobre a mesma cobrança.
   */
  const primeiraVez = await registrarUmaVez(ACAO_ESTORNO_DE_OUTRO_CONTRATO, "Subscription", sub.id, pay.id ?? null, {
    evento: event,
    recorrenciaDaCobranca: pay.subscription ?? null,
    recorrenciaEmVigor: sub.externalRef,
    valorCents: valor,
  });

  if (primeiraVez) {
    await alertarOperacao({
      tipo: "asaas_estorno_de_outro_contrato",
      assunto: `Devolução de ${emReais(valor)} de uma cobrança que não é a do contrato atual`,
      linhas: [
        `Cliente: ${dono?.email ?? "não identificado"}.`,
        `Cobrança devolvida: ${pay.id ?? "-"}, da recorrência ${pay.subscription ?? "-"}.`,
        `Contrato em vigor: assinatura ${sub.id} (recorrência ${sub.externalRef ?? "-"}), situação ${sub.status}.`,
        `Evento recebido: ${event}.`,
        "O contrato em vigor NÃO foi afetado: o acesso e os créditos continuam como estavam.",
        "A devolução foi registrada no extrato da conta.",
      ],
      acao:
        "Decida se o acesso atual deve ser afetado, porque isso depende do motivo da devolução —" +
        " o evento não o informa. Se foi CONTESTAÇÃO (chargeback), trate como estorno de verdade pela" +
        " ação 'Interromper cobrança' do painel; se foi cortesia ou ajuste de uma cobrança antiga," +
        " não há nada a fazer além de conferir o extrato.",
      metadata: {
        source: "asaas",
        subscriptionId: sub.id,
        pagamento: pay.id ?? null,
        recorrenciaDaCobranca: pay.subscription ?? null,
        recorrenciaEmVigor: sub.externalRef,
        evento: event,
        valorCents: valor,
      },
    });
  }

  return {
    action: "estorno",
    userId: dono?.id,
    message:
      `Devolução de ${emReais(valor)} de cobrança de outra recorrência: registrada, sem afetar o` +
      " contrato em vigor. A operação foi avisada para decidir o caso.",
  };
}

async function handleEstorno(pay: AsaasPayment, event: string): Promise<ProcessResult> {
  /**
   * Quantia PENDENTE é tratada ANTES de qualquer outra coisa, e isso conserta dois
   * casos que o caminho comum estragava:
   *
   *  - Dinheiro órfão devolvido: não há assinatura, o evento era ignorado e a linha
   *    ficava eternamente na tela de pendências.
   *
   *  - Cobrança indevida devolvida (a que caiu depois do cancelamento): aqui existe
   *    assinatura, e o caminho comum é destrutivo — ele marcaria a conta como
   *    ESTORNADA, bloquearia o saldo e mandaria ao cliente um "estorno processado,
   *    assinatura encerrada". Seria punir o cliente pela devolução de uma cobrança
   *    que NÓS fizemos por engano.
   */
  const dePendente = await estornoDePendente(pay, event);
  if (dePendente) return dePendente;

  const sub = await acharSub(pay);
  if (!sub) return { action: "ignorado", message: "Assinatura não encontrada." };

  /**
   * ⚠️ A cobrança devolvida é DESTE contrato? Antes de qualquer desfazimento.
   *
   * Vem primeiro porque tudo o que está abaixo pressupõe que a devolução é da cobrança que
   * paga o contrato em vigor — e quando não é, cada caminho abaixo erra: o total encerra a
   * assinatura e bloqueia o saldo, o parcial alerta sobre o contrato errado. Ver
   * `estornoDeOutroContrato`.
   */
  if (ehDeOutraRecorrencia(sub, pay)) return estornoDeOutroContrato(sub, pay, event);

  /**
   * ⚠️ DEVOLUÇÃO PARCIAL não desfaz o contrato.
   *
   * O evento de devolução parcial caía no mesmo caminho da total, e o efeito era
   * desproporcional ao ponto de ser absurdo: devolver R$ 10,00 de uma mensalidade de
   * R$ 49,90 — um desconto de cortesia, um ajuste de cobrança — punha a conta em
   * ESTORNADA, recusava o login, bloqueava os 20 créditos do mês e mandava ao cliente
   * "assinatura encerrada por estorno". O cliente recebia dez reais e perdia o serviço
   * que pagou.
   *
   * Parte do dinheiro voltou; a outra parte continua paga, e o que ela comprou continua
   * entregue. Então nada é desfeito aqui — e o caso vai para uma pessoa, porque
   * devolução parcial numa mensalidade é sempre decisão de alguém, e o sistema não sabe
   * QUANTO foi devolvido: o evento traz o valor da cobrança, não o da devolução.
   */
  /**
   * O QUE foi estornado decide o que se desfaz.
   *
   * Antes, qualquer estorno era tratado como estorno da ASSINATURA: a conta virava
   * ESTORNADA, o login passava a ser recusado e TODO o saldo era bloqueado. Aplicado
   * ao crédito avulso, o efeito era desproporcional ao ponto de ser absurdo — a
   * devolução de R$ 5,00 derrubava um plano de R$ 49,90 já pago, tirava o cliente do
   * ar e zerava os 20 créditos do mês. Um pedido de reembolso de um crédito virava
   * perda do serviço inteiro.
   *
   * A referência da compra diz o tipo, pelos mesmos dois caminhos que a aprovação
   * usa: o campo do provedor e, quando ele vem nulo, a sessão de checkout gravada.
   */
  let ref = parseRef(pay.externalReference);
  if (!ref && pay.checkoutSession) ref = await refDaSessaoDeCheckout(pay.checkoutSession);

  /**
   * ⚠️ DEVOLUÇÃO PARCIAL não desfaz o contrato — vem antes de qualquer desfazimento.
   *
   * O evento de devolução parcial caía no mesmo caminho da total, e o efeito era
   * desproporcional ao ponto de ser absurdo: devolver R$ 10,00 de uma mensalidade de
   * R$ 49,90 — um desconto de cortesia, um ajuste de cobrança — punha a conta em
   * ESTORNADA, recusava o login, bloqueava os 20 créditos do mês e mandava ao cliente
   * "assinatura encerrada por estorno". O cliente recebia dez reais e perdia o serviço
   * que pagou. No crédito avulso, a mesma devolução parcial retirava o pacote inteiro.
   *
   * Parte do dinheiro voltou; a outra parte continua paga, e o que ela comprou continua
   * entregue. Então nada é desfeito, e o caso vai para uma pessoa — porque devolução
   * parcial é sempre decisão de alguém, e o sistema não sabe QUANTO foi devolvido: o
   * evento traz o valor da cobrança, não o da devolução.
   *
   * Fica depois da leitura da referência só para o alerta poder dizer O QUE foi comprado.
   */
  if (ehDevolucaoParcial(event)) return devolucaoParcialDaAssinatura(sub, pay, event, ref?.tipo ?? null);

  if (ref?.tipo === "pacote") return estornoDePacote(sub, ref.slug, pay, event);

  /**
   * ⚠️ Devolver a DIFERENÇA DE UPGRADE não encerra a assinatura.
   *
   * A cobrança do upgrade é avulsa: cobre só os dias que faltavam do ciclo. Devolvê-la
   * caía no caminho da devolução da MENSALIDADE — conta em ESTORNADA, login recusado,
   * todo o saldo bloqueado. Devolver R$ 40,00 de proporcional derrubava o plano inteiro.
   *
   * O que se desfaz de verdade — descer o plano de volta e retirar a cota adicional —
   * depende de saber se a cota já foi usada, e isso é decisão de quem atende. Aqui o
   * sistema faz o que pode afirmar: não destrói nada e chama uma pessoa.
   */
  if (ref?.tipo === "upgrade") return estornoDeUpgrade(sub, ref.slug, pay, event);

  // Reenvio do evento de estorno não pode gerar segundo aviso ao cliente.
  const repetido = sub.status === "ESTORNADA";

  // Estorno devolve o dinheiro, então o crédito que aquele pagamento comprou não
  // pode continuar valendo. Bloqueia o saldo não usado e deixa registrado na razão.
  const saldoMensal = Math.max(0, sub.analysesQuota - sub.analysesUsed);
  const aBloquear = saldoMensal + sub.extraAnalyses;

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { status: "ESTORNADA", canceledAt: new Date(), canceledReason: `Estorno (${event})`, analysesUsed: sub.analysesQuota, extraAnalyses: 0 },
  });
  /**
   * ⚠️ O bloqueio é CONFERIDO antes de gravar, e não confiado à chave única.
   *
   * A chave `estorno-asaas:<pagamento>` impede o lançamento duplicado — mas impede
   * LANÇANDO EXCEÇÃO, e uma exceção aqui derruba o webhook inteiro com HTTP 500. No
   * Asaas isso não é só um evento perdido: a fila de sincronização da conta é
   * INTERROMPIDA no evento que falha, e nenhum evento posterior é entregue enquanto ele
   * não passar. Um estorno reenviado travaria a entrada de TODOS os pagamentos seguintes.
   *
   * E o caminho existe de verdade: o par de eventos de estorno chega duas vezes, e se
   * entre as duas o cliente recebeu crédito novo (virada de ciclo, compra avulsa), o
   * segundo evento encontra saldo a bloquear e tenta gravar com a mesma chave.
   */
  const jaBloqueado = await prisma.creditLedger.findUnique({
    where: { idempotencyKey: `estorno-asaas:${pay.id}` },
    select: { id: true },
  });
  if (aBloquear > 0 && !jaBloqueado) {
    await prisma.creditLedger.create({
      data: {
        subscriptionId: sub.id,
        kind: "AJUSTE_ADMIN",
        bucket: null,
        quantity: -aBloquear,
        balanceBefore: aBloquear,
        balanceAfter: 0,
        description: "Créditos bloqueados por estorno do pagamento",
        reason: `Estorno (${event}), caso encaminhado para revisão administrativa`,
        idempotencyKey: `estorno-asaas:${pay.id}`,
      },
    });
  }
  const amountCents = typeof pay.value === "number" ? Math.round(pay.value * 100) : sub.amountCents;
  await recordPayment(sub.id, pay.id!, "ESTORNADO", amountCents, pay.billingType ?? null, null);

  /**
   * ⚠️ ESTORNO TEM DE PARAR A COBRANÇA, e não parava.
   *
   * A assinatura era marcada ESTORNADA, o acesso caía, os créditos eram bloqueados — e a
   * recorrência seguia viva no Asaas, debitando o cartão todo mês. O cliente ficava
   * pagando por um serviço que ele não conseguia nem abrir, exatamente depois de o
   * dinheiro ter sido devolvido a ele (ou de ele ter contestado a cobrança).
   *
   * É o mesmo defeito que o cancelamento pelo painel tinha, aqui pelo pior caminho: no
   * chargeback, insistir na cobrança de quem já contestou é o caminho mais curto para
   * novas contestações — e o índice de contestação é o que fecha conta de gateway.
   *
   * A Política de Cancelamento §6 já publica que a assinatura é ENCERRADA por estorno.
   * Encerrada e cobrando é contradição, não interpretação.
   */
  const cobrancaSegueViva = await cancelarRecorrencia(sub.externalRef, {
    tipoEvento: "asaas_estorno_recorrencia_ativa",
    contexto: { motivo: "estorno", subscriptionId: sub.id, evento: event },
  });

  const dono = await donoDa(sub);

  if (cobrancaSegueViva) {
    /**
     * Alerta, e não só registro de segurança: aqui a consequência é cobrar todo mês um
     * cliente que está bloqueado e já teve o dinheiro devolvido. Não se conserta sozinho.
     */
    await alertarOperacao({
      tipo: "asaas_estorno_com_cobranca_ativa",
      assunto: "Estorno processado, mas a cobrança NÃO foi interrompida",
      linhas: [
        `Cliente: ${dono?.email ?? "não identificado"}.`,
        `Assinatura: ${sub.id} (recorrência: ${sub.externalRef ?? "-"}).`,
        `Evento: ${event}. Falha ao encerrar a recorrência: ${cobrancaSegueViva}`,
        "A conta está BLOQUEADA e a cobrança segue ativa no provedor.",
      ],
      acao:
        "Encerre a recorrência à mão no painel do Asaas agora. Enquanto ela viver, o cliente é" +
        " debitado todo mês por um serviço que não consegue abrir.",
      metadata: { subscriptionId: sub.id, assinatura: sub.externalRef, evento: event, erro: cobrancaSegueViva },
    });
  }
  const aviso =
    dono && !repetido
      ? await notificar("estorno", dono.id, () => sendRefunded({ email: dono.email, name: dono.name }))
      : undefined;
  return { action: "estorno", userId: dono?.id, message: comAviso("Assinatura encerrada por estorno.", aviso) };
}

async function handleCancelado(pay: AsaasPayment): Promise<ProcessResult> {
  const sub = await acharSub(pay);
  if (!sub) {
    /**
     * Cobrança apagada de contratação que nunca virou assinatura aqui. É o desfecho BOM da
     * contratação abandonada: alguém limpou a recorrência no provedor. Registra sem alertar
     * — a bagunça está sendo desfeita, e avisar aqui só atrapalharia quem acabou de agir.
     */
    await logAudit({
      action: "asaas.cobranca_apagada_sem_assinatura",
      entityType: "Subscription",
      entityId: pay.subscription ?? pay.id ?? "sem-id",
      metadata: { recorrencia: pay.subscription ?? null, pagamento: pay.id ?? null },
    });
    return { action: "ignorado", message: "Cobrança apagada de contratação sem assinatura aqui: nada a cancelar." };
  }

  /**
   * ⚠️ A cobrança é de OUTRA recorrência? Então não é esta assinatura que foi cancelada.
   *
   * Aqui o estrago era imediato: apagar no painel do Asaas o boleto de uma contratação
   * abandonada CANCELAVA a assinatura que o cliente tinha paga, porque `acharSub` chega à
   * conta pela referência e pega a assinatura mais recente dela, qualquer que seja a
   * recorrência. Limpar a lista de cobranças derrubava contrato em dia.
   */
  if (ehDeOutraRecorrencia(sub, pay)) {
    return contratacaoSemAssinaturaLocal(pay, "PAYMENT_DELETED", "a cobrança apagada é de outra recorrência do Asaas");
  }

  /**
   * ⚠️ Cobrança AVULSA apagada não cancela a assinatura.
   *
   * Apagar no painel do Asaas a cobrança de R$ 5,00 que o cliente não pagou — limpeza de
   * rotina — mandava PAYMENT_DELETED, e a assinatura mensal era CANCELADA, com e-mail de
   * cancelamento ao cliente. Arrumar a lista de cobranças derrubava um contrato ativo.
   */
  const tipo = await tipoDaCobranca(pay);
  if (ehAvulsa(tipo)) return avulsaNaoAfetaAssinatura(sub, pay, "PAYMENT_DELETED", tipo as "pacote" | "upgrade");

  const repetido = sub.status === "CANCELADA";

  /**
   * O motivo original é PRESERVADO quando já existe pedido de parada, e isto não é
   * detalhe de registro.
   *
   * Este evento é consequência do nosso próprio cancelamento: `cancelarRecorrencia`
   * faz DELETE da recorrência, o Asaas remove as cobranças pendentes dela e manda
   * PAYMENT_DELETED para cada uma. Sobrescrever aqui trocava
   * "Cancelamento solicitado pelo cliente" por "Cancelamento via Asaas" minutos depois
   * do pedido — apagando, na versão anterior desta garantia, exatamente o rastro que
   * faria a cobrança seguinte ser barrada. O cancelamento se autossabotava.
   */
  const preservarMotivo = canceladaAPedido(sub);

  // Política: cancela cobranças futuras, mas mantém o acesso até currentPeriodEnd.
  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status: "CANCELADA",
      ...(preservarMotivo
        ? {}
        : { canceledAt: new Date(), canceledReason: "Cancelamento via Asaas" }),
    },
  });
  // O aviso informa até quando o acesso continua valendo — é o que evita o
  // chamado "cancelei e continuo entrando, isso é cobrança indevida?".
  const dono = await donoDa(sub);
  const aviso =
    dono && !repetido
      ? await notificar("cancelamento", dono.id, () =>
          sendCanceled({ email: dono.email, name: dono.name }, sub.currentPeriodEnd),
        )
      : undefined;
  return {
    action: "cancelado",
    userId: dono?.id,
    message: comAviso("Assinatura cancelada (acesso mantido até o fim do período pago).", aviso),
  };
}

// ---------------------------------------------------------------------------
// Aviso ao cliente
// ---------------------------------------------------------------------------

/**
 * Envia o aviso ao cliente sem deixar que ele invalide o pagamento.
 *
 * Duas coisas estavam erradas aqui e as duas custam confiança:
 *
 * 1. Não saía e-mail NENHUM. O cliente pagava — assinava, renovava, atrasava, era
 *    estornado — e não recebia uma linha. Silêncio depois de uma cobrança no
 *    cartão é o que gera chamado de suporte e pedido de estorno.
 *
 * 2. Enviar sem proteção seria pior. O aviso é a ÚLTIMA etapa, depois de
 *    assinatura, pagamento e créditos gravados. Se uma queda do provedor de
 *    e-mail derrubasse a função, o webhook devolveria erro para um pagamento que
 *    entrou, o Asaas reenviaria e, esgotadas as tentativas, sobraria um cliente
 *    pago com o registro num estado que ninguém revisa. O comportamento está
 *    travado em tests/asaas-email-falha.test.ts.
 *
 * O dinheiro entrou e o acesso existe: conclui, registra a falha do aviso na
 * auditoria e devolve o motivo na mensagem.
 */
async function notificar(
  tipo: string,
  userId: string,
  envio: () => Promise<void>,
): Promise<string | undefined> {
  try {
    await envio();
    return undefined;
  } catch (err) {
    const motivo = (err as Error).message;
    console.error(`[asaas] pagamento processado, mas o e-mail (${tipo}) NÃO foi enviado:`, motivo);
    await logAudit({
      action: "asaas.email.failed",
      entityType: "User",
      entityId: userId,
      metadata: { tipo, erro: motivo },
    });
    return motivo;
  }
}

/** Junta a mensagem de sucesso com o aviso de e-mail que não saiu, quando houver. */
function comAviso(mensagem: string, aviso?: string): string {
  return aviso ? `${mensagem} O e-mail de aviso não saiu: ${aviso}` : mensagem;
}

/** Dono da conta ligada à assinatura — destinatário dos avisos. */
async function donoDa(sub: Subscription): Promise<{ id: string; email: string; name: string } | null> {
  const org = await prisma.organization.findUnique({
    where: { id: sub.organizationId },
    select: { owner: { select: { id: true, email: true, name: true } } },
  });
  return org?.owner ?? null;
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

/**
 * Acha a assinatura local ligada a este pagamento.
 *
 * ⚠️ A ORDEM das duas vias é o conserto, e não um detalhe de estilo.
 *
 * A via LARGA vinha primeiro: pela referência da compra chega-se à CONTA e, da conta, à
 * assinatura MAIS RECENTE — qualquer que seja a recorrência dela. A via PRECISA (a
 * recorrência que o próprio evento nomeia) só era consultada quando a larga não achava
 * nada, ou seja, quase nunca. Resultado: evento de uma segunda contratação da mesma conta
 * caía sobre o contrato corrente, e foi assim que boleto abandonado derrubou assinatura
 * paga.
 *
 * Invertida, quando o evento diz de qual recorrência ele é e essa recorrência existe aqui,
 * é ela que responde. A via larga volta ao papel de RECUO, que é o que ela sempre deveria
 * ter sido — ela existe porque o PIX não tem recorrência a comparar (cobrança única) e
 * porque a primeira cobrança de uma recorrência ainda não tem assinatura local.
 *
 * A inversão não faz a busca achar MENOS: as duas vias continuam sendo tentadas, só muda
 * quem responde quando as duas achariam. E ela não basta sozinha — `ativarAssinatura`
 * ATUALIZA a assinatura da organização em vez de criar outra, então trocar de boleto para
 * PIX sobrescreve o `externalRef` e a recorrência antiga deixa de existir aqui. Para esse
 * caso quem segura é `ehDeOutraRecorrencia`.
 */
async function acharSub(pay: AsaasPayment): Promise<Subscription | null> {
  if (pay.subscription) {
    const s = await prisma.subscription.findFirst({ where: { externalRef: pay.subscription } });
    if (s) return s;
  }
  const ref = parseRef(pay.externalReference);
  if (ref) {
    const org = await prisma.organization.findFirst({ where: { ownerId: ref.userId } });
    if (org) {
      const s = await prisma.subscription.findFirst({ where: { organizationId: org.id }, orderBy: { createdAt: "desc" } });
      if (s) return s;
    }
  }
  return null;
}

/** A organização da conta que pagou, criada na primeira aprovação. Ver `garantirOrganizacao`. */
async function obterOuCriarOrg(userId: string, nome: string) {
  return garantirOrganizacao(userId, nome);
}

async function ativarAssinatura(
  orgId: string,
  plan: { id: string; period: string | null; monthlyAnalyses: number; maxUsers: number; priceCents: number },
  pay: AsaasPayment,
  amountCents: number,
  /** Evento reenviado do MESMO pagamento: não soma período de novo. */
  repetido = false,
): Promise<Subscription> {
  // Guarda o id da assinatura Asaas (quando houver) para reconhecer as renovações.
  const externalRef = pay.subscription ?? pay.id!;
  const valor = amountCents || plan.priceCents;

  /**
   * Esta contratação renova sozinha?
   *
   * Só renova quando o Asaas criou uma ASSINATURA do lado dele, o que acontece no
   * cartão. No PIX a cobrança é única — não existe mandato de débito, o Asaas não
   * tem como cobrar de novo — e o pagamento chega sem `subscription`. Nesse caso
   * `nextRenewalAt` fica NULO de propósito: é o que distingue, em toda a
   * aplicação, "vai renovar" de "vale um ciclo e encerra". Preencher a data
   * prometeria ao cliente uma renovação que nunca vem.
   */
  const renovaSozinha = Boolean(pay.subscription);

  const existing = await prisma.subscription.findFirst({ where: { organizationId: orgId }, orderBy: { createdAt: "desc" } });

  /**
   * O período é ESTENDIDO a partir do fim já pago, não recomeçado em agora — ver
   * `computePeriodEnd`. E não é somado quando o evento é reenvio do mesmo pagamento:
   * o par CONFIRMED→RECEIVED chega duas vezes, e somar nas duas daria dois meses por
   * um pagamento.
   */
  const fim =
    repetido && existing?.currentPeriodEnd
      ? existing.currentPeriodEnd
      : computePeriodEnd(plan.period, existing?.currentPeriodEnd ?? null);
  const proximaRenovacao = renovaSozinha ? fim : null;

  /**
   * Duas recorrências para o mesmo cliente = cobrança dupla todo mês.
   *
   * Aconteceu de verdade no primeiro teste de pagamento: o cliente pagou, nada foi
   * liberado (outro defeito), ele tentou de novo, e ficou com DUAS assinaturas
   * ATIVAS no Asaas cobrando R$ 39,90 cada — com as duas próximas cobranças já
   * agendadas. Nada no sistema impedia nem avisava.
   *
   * Nada aqui impede o cliente de abrir dois checkouts; o que se pode fazer é, ao
   * ativar, encerrar a recorrência ANTERIOR quando ela é diferente da que está
   * chegando. Falhar não desfaz a ativação — o dinheiro entrou —, mas fica
   * registrado para alguém cancelar à mão.
   */
  /**
   * Só tenta cancelar o que É uma recorrência.
   *
   * Em cobrança única (PIX) `externalRef` guarda o id do PAGAMENTO, não de uma
   * assinatura — `pay_...` em vez de `sub_...`. Chamar DELETE /subscriptions com um id
   * de pagamento devolve erro e registra um evento de segurança de "recorrência
   * duplicada" que não existe: ruído exatamente no caminho normal de quem pagou por
   * PIX e depois assinou no cartão ou no boleto.
   */
  const anteriorEhRecorrencia = existing?.externalRef?.startsWith("sub_") ?? false;
  if (anteriorEhRecorrencia && existing!.externalRef !== externalRef) {
    await cancelarRecorrencia(existing!.externalRef, {
      tipoEvento: "asaas_recorrencia_duplicada",
      contexto: {
        motivo: "cliente_com_duas_assinaturas",
        assinaturaAnterior: existing!.externalRef,
        assinaturaNova: externalRef,
        organizacao: orgId,
      },
    });
  }

  /**
   * ⚠️ Contratar de novo NÃO desfaz suspensão administrativa.
   *
   * A sanção é sobre o ACESSO, e o pagamento reativava a conta também por aqui — então
   * bastava comprar outra vez para contornar a suspensão. Um caminho de compra não pode
   * ser a porta de saída de uma medida de uso aceitável.
   *
   * O período contratado e a cota são preservados (o dinheiro entrou e comprou o que
   * comprou); quem devolve o acesso é o painel, por decisão de quem suspendeu. Ver o
   * mesmo raciocínio no caminho de renovação, em `handleAprovado`.
   */
  const suspensaPorDecisao = existing?.status === "SUSPENSA";

  let sub: Subscription;
  if (existing) {
    sub = await prisma.subscription.update({
      where: { id: existing.id },
      data: {
        planId: plan.id,
        ...(suspensaPorDecisao ? {} : { status: "ATIVA", suspendedAt: null }),
        provider: "ASAAS",
        externalRef,
        amountCents: valor,
        currentPeriodEnd: fim,
        nextRenewalAt: proximaRenovacao,
        maxUsers: plan.maxUsers ?? 1,
        canceledAt: null,
        canceledReason: null,
        /**
         * O pedido de parada só é apagado AQUI, e só porque chegar até aqui já
         * significa contratação NOVA: `handleAprovado` desvia antes qualquer cobrança
         * da contratação que foi mandada parar (ver `assinaturaComPedidoDeParada`).
         * Quem cancelou e voltou por vontade própria recomeça limpo; quem cancelou e
         * só viu a cobrança voltar, não.
         */
        canceledByRequestAt: null,
        graceUntil: null,
      },
    });
  } else {
    sub = await prisma.subscription.create({
      data: {
        organizationId: orgId,
        planId: plan.id,
        status: "ATIVA",
        provider: "ASAAS",
        externalRef,
        amountCents: valor,
        currentPeriodEnd: fim,
        nextRenewalAt: proximaRenovacao,
        maxUsers: plan.maxUsers ?? 1,
        analysesQuota: plan.monthlyAnalyses ?? 0,
      },
    });
  }
  await recordPayment(sub.id, pay.id!, "APROVADO", valor, pay.billingType ?? null, new Date());
  return sub;
}

/**
 * Payment idempotente por (externalId + status): reenvio do webhook não duplica.
 *
 * `subscriptionId` é nulo quando o dinheiro entrou e NÃO se sabe de quem é — ver
 * `dinheiroSemDestino`. Gravar sem assinatura é o que faz a quantia existir no
 * sistema em vez de sumir.
 */
async function recordPayment(
  subscriptionId: string | null,
  externalId: string,
  status: PaymentStatus,
  amountCents: number,
  method: string | null,
  paidAt: Date | null,
) {
  if (externalId) {
    const dup = await prisma.payment.findFirst({ where: { externalId, status } });
    if (dup) return dup;
  }
  return prisma.payment.create({
    data: { subscriptionId, provider: "ASAAS", externalId, status, amountCents, method, paidAt },
  });
}

/**
 * Fim do período pago depois de somar UM ciclo.
 *
 * `base` é de onde a soma parte, e é o ponto do conserto: a função somava sempre a
 * partir de AGORA, o que SOBRESCREVIA o período em vez de estender. Dois boletos em
 * aberto pagos no mesmo dia compravam um mês só — R$ 99,80 por trinta dias —, e a
 * renovação paga antes do vencimento apagava os dias que faltavam do ciclo corrente.
 *
 * A base correta é o que estiver mais à frente entre o fim já pago e agora: renovação
 * antecipada preserva os dias restantes, e renovação atrasada não presenteia o
 * intervalo em que o cliente ficou sem pagar.
 */
function computePeriodEnd(period?: string | null, base?: Date | null): Date {
  const agora = new Date();
  const partida = base && base.getTime() > agora.getTime() ? new Date(base.getTime()) : agora;
  if (period === "ANUAL") return new Date(partida.setFullYear(partida.getFullYear() + 1));
  return new Date(partida.setMonth(partida.getMonth() + 1));
}
