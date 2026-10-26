import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireRole, revokeAllSessions } from "@/lib/auth";
import { logAudit, logSecurityEvent } from "@/lib/audit";
import { corrigirEmail } from "@/lib/ativacao-manual";
import { inventarioDaConta, apagarConta } from "@/lib/apagar-conta";
import { z } from "zod";

const patchSchema = z.object({
  status: z.enum(["ATIVO", "BLOQUEADO", "SUSPENSO", "PENDENTE_VERIFICACAO"]).optional(),
  role: z.enum(["ADMIN", "CLIENTE", "REVISOR", "SUPORTE"]).optional(),
  /**
   * Correção de e-mail. Existe porque e-mail errado no checkout era
   * irreversível pela interface: o link de criação de senha e o "esqueci minha
   * senha" iam para o endereço errado, e o cliente pagante nunca entrava.
   */
  email: z.string().email("Informe um e-mail válido.").optional(),
});

export const PATCH = route(async (req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const admin = await requireRole("ADMIN");
  const data = patchSchema.parse(await req.json());

  /**
   * Trava de auto-exclusão.
   *
   * Sem isto, um clique em "Bloquear" na própria linha bloqueia o administrador
   * e revoga as sessões dele na hora (abaixo). Sendo ele o único ADMIN, não
   * sobra ninguém para reverter — o sistema fica sem administrador. A saída
   * existe (redefinir senha reativa a conta), mas nada na tela informa isso, e
   * descobrir sob pressão é caro.
   *
   * Rejeitar no SERVIDOR, e não só esconder o botão: a confirmação da interface
   * é conveniência, esta é a garantia.
   */
  if (params.id === admin.id) {
    if (data.status && data.status !== "ATIVO") {
      return fail("Você não pode bloquear ou suspender a sua própria conta de administrador.", 400);
    }
    if (data.role && data.role !== "ADMIN") {
      return fail("Você não pode remover o seu próprio papel de administrador — ficaria sem acesso ao painel.", 400);
    }
  }

  // Correção de e-mail passa por caminho próprio: valida formato, recusa
  // duplicidade e registra o "de → para" na auditoria, o que um update solto
  // não faria.
  if (data.email) {
    try {
      await corrigirEmail(params.id, data.email, { id: admin.id });
    } catch (err) {
      return fail((err as Error).message, 422);
    }
  }

  /**
   * O papel ANTERIOR é lido antes da alteração, e é o que permite saber se ele mudou de fato.
   * Sem a comparação, um PATCH que reenvia o mesmo papel — salvar a tela sem mexer nele —
   * derrubaria a sessão da pessoa por nada.
   */
  const antes = await prisma.user.findUniqueOrThrow({
    where: { id: params.id },
    select: { role: true },
  });

  const { email: _ignorado, ...resto } = data;
  const user = Object.keys(resto).length
    ? await prisma.user.update({ where: { id: params.id }, data: resto })
    : await prisma.user.findUniqueOrThrow({ where: { id: params.id } });

  const papelMudou = user.role !== antes.role;

  /**
   * Sessões revogadas quando o acesso muda de natureza.
   *
   * Bloquear/suspender já revogava. A TROCA DE PAPEL passou a revogar também, e o motivo
   * ficou concreto com o encerramento por inatividade: o prazo depende do papel — equipe tem
   * o curto, cliente o comum — e o relógio da TELA recebe esse número no render do layout.
   * Sem revogar, um cliente promovido continuava com o relógio de 30 minutos na tela enquanto
   * o servidor já aplicava 10 (ele relê o papel do banco em toda requisição). O resultado é o
   * pior estado possível: sessão recusada no servidor com a tela ainda aberta e os dados à
   * mostra, exatamente o que o encerramento por inatividade existe para evitar.
   *
   * Vale nos dois sentidos, e o outro é de segurança comum: rebaixar alguém deixava a tela
   * dele ainda desenhada com o menu e os atalhos do papel antigo até a próxima navegação.
   * Trocar privilégio e exigir entrada nova é o que se espera de um sistema que guarda
   * processo de terceiro.
   */
  if (data.status === "BLOQUEADO" || data.status === "SUSPENSO" || papelMudou) {
    await revokeAllSessions(user.id);
  }

  if (papelMudou) {
    /**
     * Registro de segurança além da auditoria: a pessoa vai ser desconectada sem explicação na
     * tela — não há onde guardar o motivo, porque a sessão dela deixou de existir. Este
     * registro é o que permite responder "por que fui desconectado?" quando ela perguntar.
     */
    await logSecurityEvent({
      type: "sessoes_revogadas_por_troca_de_papel",
      email: user.email,
      metadata: { de: antes.role, para: user.role, porAdmin: admin.id },
    });
  }

  await logAudit({
    actorId: admin.id,
    actorRole: "ADMIN",
    action: "admin.user.update",
    entityType: "User",
    entityId: user.id,
    // O de→para do papel entra na auditoria: "fields: [role]" não diz o que mudou.
    metadata: {
      fields: Object.keys(data),
      ...(papelMudou ? { papelDe: antes.role, papelPara: user.role, sessoesRevogadas: true } : {}),
    },
  });
  return ok({ id: user.id, status: user.status, role: user.role });
});

/**
 * Inventário do que a exclusão levaria. Não altera nada.
 *
 * A tela consulta isto ANTES de pedir confirmação: "apagar conta" é irreversível,
 * e confirmar sem saber que junto vão 3 análises e 2 pagamentos é decidir no
 * escuro.
 */
export const GET = route(async (_req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  await requireRole("ADMIN");
  const alvo = await prisma.user.findUnique({ where: { id: params.id }, select: { email: true } });
  if (!alvo) return fail("Usuário não encontrado.", 404);

  const inventario = await inventarioDaConta(alvo.email);
  if (!inventario) return fail("Usuário não encontrado.", 404);
  return ok({ inventario });
});

const deleteSchema = z.object({
  /**
   * O e-mail digitado por quem está apagando, para conferir com o da conta.
   *
   * É a proteção contra apagar a linha errada: um clique num botão de tabela é
   * fácil de dar na fileira de cima, e aqui não há desfazer.
   */
  emailConfirmacao: z.string().min(1, "Digite o e-mail da conta para confirmar."),
  /** Assumir a exclusão de conta com pagamento aprovado (cliente real). */
  forcar: z.boolean().optional(),
});

/**
 * Exclusão definitiva de uma conta pelo painel.
 *
 * A lógica, a ordem das chaves estrangeiras e as travas vivem em
 * `src/lib/apagar-conta.ts`, com testes — inclusive o de que apagar a pessoa antes
 * da organização é recusado pelo banco. Aqui só se cuida da autorização, da
 * confirmação e de traduzir a recusa para o operador.
 *
 * ⚠️ NÃO é a exclusão do art. 18 da LGPD, que exige anonimização (preservar o
 * histórico contábil sem o vínculo à pessoa). Isto DESTRÓI o histórico junto, e é
 * por isso que existe a trava do pagamento aprovado.
 */
export const DELETE = route(async (req: NextRequest, { params: paramsAsync }: { params: Promise<{ id: string }> }) => {
  const params = await paramsAsync;
  const admin = await requireRole("ADMIN");

  // Primeira trava, antes de qualquer coisa: ninguém apaga a própria conta.
  if (params.id === admin.id) {
    return fail("Você não pode apagar a sua própria conta de administrador.", 400);
  }

  const dados = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!dados.success) return fail(dados.error.issues[0]?.message ?? "Dados inválidos.", 422);

  const alvo = await prisma.user.findUnique({ where: { id: params.id }, select: { email: true } });
  if (!alvo) return fail("Usuário não encontrado.", 404);

  if (dados.data.emailConfirmacao.trim().toLowerCase() !== alvo.email.toLowerCase()) {
    return fail("O e-mail digitado não confere com o da conta. Nada foi apagado.", 422);
  }

  const r = await apagarConta(alvo.email, { forcar: dados.data.forcar });

  if (r.recusa === "nao_encontrada") return fail("Usuário não encontrado.", 404);
  if (r.recusa === "e_admin") {
    return fail("Esta conta é ADMIN. Mude o perfil para CLIENTE antes de apagar, se for realmente a intenção.", 409);
  }
  if (r.recusa === "tem_pagamento_aprovado") {
    return fail(
      /**
       * A mensagem dizia "apagar destrói o histórico da venda", e deixou de ser verdade: a
       * linha do pagamento passou a ser preservada sem dono. Manter o texto antigo faria o
       * sistema assustar com uma consequência que não existe mais — e assustar com o que é
       * falso é como se aprende a ignorar o aviso que é verdadeiro. O que se perde de fato
       * é o VÍNCULO: quanto entrou continua registrado, de quem veio, não.
       */
      `Esta conta tem ${r.inventario?.pagamentosAprovados} pagamento(s) aprovado(s) — é um cliente que pagou. ` +
        `O valor recebido continua registrado, mas você perde a quem ele pertencia: nome, e-mail e ` +
        `histórico de uso vão embora, e a venda fica sem cliente identificado. ` +
        `Se ainda assim for a intenção (cobrança de teste, por exemplo), confirme marcando a opção de forçar.`,
      409,
    );
  }
  if (r.recusa === "tem_pagamento_a_devolver") {
    return fail(
      `Esta conta tem ${r.inventario?.pagamentosADevolver} quantia(s) recebida(s) que ainda devem ser DEVOLVIDAS a ela. ` +
        `Apagar a conta não apaga o valor, mas apaga quem é o credor — e a devolução fica sem destinatário. ` +
        `Devolva pelo painel do Asaas (ou encerre o caso em Registros → Dinheiro sem destino) e depois apague.`,
      409,
    );
  }
  if (!r.apagado) return fail("Não foi possível apagar a conta.", 500);

  await logAudit({
    actorId: admin.id,
    actorRole: "ADMIN",
    action: "admin.user.deleted",
    entityType: "User",
    entityId: params.id,
    metadata: {
      email: alvo.email,
      organizacoes: r.inventario?.organizacoes.length ?? 0,
      assinaturas: r.inventario?.assinaturas.length ?? 0,
      pagamentos: r.inventario?.pagamentos ?? 0,
      pagamentosAprovados: r.inventario?.pagamentosAprovados ?? 0,
      analises: r.inventario?.analises ?? 0,
      forcado: Boolean(dados.data.forcar),
    },
  });

  return ok({ apagado: true, email: alvo.email, inventario: r.inventario });
});
