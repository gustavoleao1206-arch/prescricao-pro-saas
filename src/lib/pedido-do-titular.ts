import { prisma } from "./db";
import { logAudit } from "./audit";
import { alertarOperacao } from "./alerta-operacional";

/**
 * O pedido de exclusão feito pelo titular, e o prazo que a Plataforma publica.
 *
 * ── O defeito que este módulo conserta ────────────────────────────────────────
 * A rota `POST /api/conta/exclusao` registra o pedido e avisa: notificação para o
 * titular, notificação para cada administrador e e-mail para o canal de privacidade.
 * Isso resolveu o pedido que se perdia — e depois disso, NADA acompanha o prazo.
 *
 * O que os documentos publicam não é pouco. A Política de Cancelamento e Retenção diz que
 * "a resposta completa" sai em até o prazo abaixo, "na forma do art. 19, II, da LGPD", e
 * que "no mesmo prazo é executada a exclusão ou a anonimização dos dados que não estejam
 * entre os de conservação obrigatória". Ou seja: não é só responder, é executar.
 *
 * Sem vigilância, o desfecho é o mesmo do prazo de revisão de estorno antes de ele ganhar
 * varredura: a notificação fica numa lista, ninguém volta nela, e o prazo vence em
 * silêncio. Prazo publicado sem mecanismo é promessa que só se cumpre por sorte, e o
 * descumprimento aqui dá ao titular razão numa reclamação à ANPD (art. 18, §3º).
 *
 * ── O que esta varredura faz, e o que NÃO faz ─────────────────────────────────
 * Ela avisa, duas vezes por pedido: quando o prazo está se aproximando e quando ele
 * venceu. Não executa nada — apagar ou anonimizar exige separar o que a lei obriga a
 * conservar do que deve sair, e isso é juízo de quem responde pelo tratamento, não de uma
 * varredura noturna. Ver `apagarConta`, que é a ferramenta desse ato.
 */

/**
 * Prazo de resposta ao titular — art. 19, II, da LGPD.
 *
 * ⚠️ FONTE ÚNICA. O número era digitado em DOIS documentos legais (Política de
 * Privacidade e Política de Cancelamento e Retenção), cada um com a sua constante local.
 * Dois textos do mesmo contrato de adesão podendo anunciar prazos diferentes é exatamente
 * o defeito que o art. 46 do CDC pune com a inexigibilidade da cláusula — e agora um
 * terceiro lugar depende do mesmo número: esta varredura, que mede o prazo praticado.
 *
 * Documento e sistema prometendo prazos diferentes seria pior que qualquer dos dois
 * errados sozinho. Por isso o valor mora aqui, junto do código que o aplica, e as duas
 * páginas o importam — o mesmo arranjo que `PRAZO_REVISAO_DIAS_UTEIS` já usa.
 */
export const PRAZO_RESPOSTA_TITULAR_DIAS = 15;

/**
 * Quantos dias ANTES do vencimento o primeiro aviso sai.
 *
 * Avisar só no vencimento seria avisar do descumprimento, não dele evitar. Cinco dias é
 * folga para separar o que se conserva do que sai, e ainda responder no prazo.
 */
export const DIAS_DE_ANTECEDENCIA_DO_AVISO = 5;

/** Ação do pedido, gravada pela rota do cliente. */
const ACAO_PEDIDO = "account.deletion_requested";
/** Ação da execução, gravada por `apagarConta`. É o que encerra o pedido. */
const ACAO_EXECUCAO = "conta.apagada";
/** Marca de que já avisamos — uma por pedido e por etapa, para não repetir. */
const ACAO_AVISO = "lgpd.prazo_do_titular_avisado";

export interface ResultadoVigilancia {
  /** Pedidos ainda sem execução. */
  abertos: number;
  /** Avisados agora porque o prazo está próximo. */
  avisadosProximos: number;
  /** Avisados agora porque o prazo JÁ venceu. */
  avisadosVencidos: number;
}

export interface PedidoEmAberto {
  userId: string;
  email: string;
  nome: string;
  pedidoEm: Date;
  vencimento: Date;
}

/**
 * Os pedidos de exclusão que ainda não foram executados.
 *
 * ⚠️ Uma regra, um lugar. Quem decide o que é "em aberto" é só esta função — a varredura
 * que avisa e o contador do painel administrativo dependem dela. Duas definições de
 * pendência é como o alerta e a tela passam a discordar, e discordância entre dois números
 * do mesmo sistema destrói a confiança nos dois.
 */
export async function pedidosEmAberto(agora: Date = new Date()): Promise<PedidoEmAberto[]> {
  /**
   * A janela de busca é generosa de propósito — quatro vezes o prazo — para que pedido
   * antigo e esquecido apareça, e não só os da semana. Sem teto nenhum a consulta cresceria
   * para sempre num registro de auditoria que é para durar anos.
   */
  const desde = new Date(agora.getTime() - PRAZO_RESPOSTA_TITULAR_DIAS * 4 * 86_400_000);
  const pedidos = await prisma.auditLog.findMany({
    where: { action: ACAO_PEDIDO, createdAt: { gte: desde } },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, createdAt: true },
  });

  const abertos: PedidoEmAberto[] = [];
  for (const pedido of pedidos) {
    if (!pedido.entityId) continue;

    /**
     * O pedido está encerrado? Duas evidências, e as duas são necessárias.
     *
     * A conta ter deixado de existir é a evidência direta. Mas `apagarConta` grava
     * `conta.apagada`, e é essa linha que sobrevive de forma legível — a conta, não.
     * Conferir as duas evita tanto cobrar o que já foi feito quanto perder o pedido cuja
     * conta saiu por outro caminho.
     */
    const [conta, execucao] = await Promise.all([
      prisma.user.findUnique({ where: { id: pedido.entityId }, select: { id: true, email: true, name: true } }),
      prisma.auditLog.findFirst({
        where: { action: ACAO_EXECUCAO, entityId: pedido.entityId },
        select: { id: true },
      }),
    ]);
    if (!conta || execucao) continue;

    abertos.push({
      userId: conta.id,
      email: conta.email,
      nome: conta.name,
      pedidoEm: pedido.createdAt,
      vencimento: new Date(pedido.createdAt.getTime() + PRAZO_RESPOSTA_TITULAR_DIAS * 86_400_000),
    });
  }
  return abertos;
}

/** Quantos pedidos de exclusão esperam execução. Lido pelo painel administrativo. */
export async function contarPedidosEmAberto(agora: Date = new Date()): Promise<number> {
  return (await pedidosEmAberto(agora)).length;
}

/**
 * Confere os pedidos de exclusão em aberto e avisa sobre o prazo.
 *
 * Idempotente por construção: cada aviso deixa registro próprio, e um pedido nunca é
 * avisado duas vezes na mesma etapa. Alerta repetido é alerta ignorado, e um prazo legal é
 * o pior lugar para treinar alguém a ignorar aviso.
 */
export async function vigiarPrazosDoTitular(agora: Date = new Date()): Promise<ResultadoVigilancia> {
  const r: ResultadoVigilancia = { abertos: 0, avisadosProximos: 0, avisadosVencidos: 0 };
  const abertos = await pedidosEmAberto(agora);
  r.abertos = abertos.length;

  for (const pedido of abertos) {
    const conta = { id: pedido.userId, email: pedido.email, name: pedido.nome };
    const vencimento = pedido.vencimento;
    const diasRestantes = Math.ceil((vencimento.getTime() - agora.getTime()) / 86_400_000);
    const venceu = vencimento.getTime() <= agora.getTime();
    const proximo = !venceu && diasRestantes <= DIAS_DE_ANTECEDENCIA_DO_AVISO;
    if (!venceu && !proximo) continue;

    const etapa = venceu ? "vencido" : "proximo";
    const jaAvisado = await prisma.auditLog.findFirst({
      where: {
        action: ACAO_AVISO,
        entityId: pedido.userId,
        metadata: { path: ["etapa"], equals: etapa },
      },
      select: { id: true },
    });
    if (jaAvisado) continue;

    await logAudit({
      action: ACAO_AVISO,
      entityType: "User",
      entityId: pedido.userId,
      metadata: { etapa, pedidoEm: pedido.pedidoEm, vencimento, diasRestantes },
    });

    await alertarOperacao({
      tipo: venceu ? "lgpd_prazo_do_titular_vencido" : "lgpd_prazo_do_titular_proximo",
      assunto: venceu
        ? `PRAZO VENCIDO: pedido de exclusão de ${conta.email} não foi executado`
        : `Pedido de exclusão de ${conta.email} vence em ${diasRestantes} dia(s)`,
      linhas: [
        `Titular: ${conta.name} (${conta.email}).`,
        `Pedido feito em ${pedido.pedidoEm.toLocaleDateString("pt-BR")}.`,
        `Prazo publicado: ${PRAZO_RESPOSTA_TITULAR_DIAS} dias — vence em ${vencimento.toLocaleDateString("pt-BR")}.`,
        venceu
          ? "O prazo do art. 19, II, da LGPD já passou e a conta continua existindo."
          : "A conta continua existindo e nada foi executado ainda.",
        "A Política publica que no mesmo prazo é EXECUTADA a exclusão ou a anonimização do que não é de conservação obrigatória — não é só responder.",
      ],
      acao:
        "Responda ao titular e execute pelo painel: Usuários → Apagar (mostra o inventário, e preserva" +
        " o registro fiscal e o rastro de segurança pseudonimizado). Havendo pagamento aprovado, a trava" +
        " pede confirmação — é o caso de conservar o registro da venda e apagar o resto." +
        (venceu ? " O prazo já venceu: registre a data real da resposta, porque ela pode ser pedida." : ""),
      metadata: {
        source: "lgpd",
        etapa,
        userId: conta.id,
        pedidoEm: pedido.pedidoEm,
        vencimento,
        diasRestantes,
      },
    });

    if (venceu) r.avisadosVencidos++;
    else r.avisadosProximos++;
  }

  return r;
}
