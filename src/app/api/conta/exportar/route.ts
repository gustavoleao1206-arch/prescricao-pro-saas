import { route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { decryptField, maskDocument } from "@/lib/crypto";
import { logAudit } from "@/lib/audit";

/** Exportação dos dados pessoais do titular (LGPD — portabilidade/acesso). */
export const GET = route(async () => {
  const session = await requireUser();
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.id },
    include: {
      consents: true,
      analyses: { select: { id: true, title: true, status: true, createdAt: true } },
      ticketsOpened: { select: { number: true, subject: true, status: true, createdAt: true } },
    },
  });

  /**
   * ⚠️ OS ACESSOS INTERNOS PASSAM A CONSTAR — era o dado que faltava justamente a quem desconfia.
   *
   * A exportação entregava perfil, consentimentos, títulos das análises e chamados. O cliente exportava, via
   * o título e o status das próprias análises, e continuava sem saber se alguém da empresa abriu os autos
   * dele. Este é o único botão de autoatendimento de LGPD do produto, e não respondia à pergunta que motiva o
   * pedido.
   *
   * ── O que vai, e o que NÃO vai, e por quê ─────────────────────────────────
   * Vai: data, ação, PAPEL de quem acessou e o item. O cliente tem direito de saber que houve acesso interno
   * e de que perfil.
   *
   * Não vai: nome, e-mail e IP de quem acessou. Isso é dado pessoal de FUNCIONÁRIO, num arquivo que o cliente
   * baixa e redistribui — e o registro de auditoria guarda IP nos downloads. Atender o direito do titular não
   * autoriza expor terceiro. Se houver pedido formal identificando a pessoa, isso se responde por processo,
   * não por download automático.
   *
   * Só os itens DELE: as análises são filtradas pelos ids que já foram carregados acima, então a consulta não
   * pode vazar acesso a item de outro cliente.
   */
  const idsDasAnalises = user.analyses.map((a) => a.id);
  const acessos = idsDasAnalises.length
    ? await prisma.auditLog.findMany({
        where: { entityType: "Analysis", entityId: { in: idsDasAnalises } },
        orderBy: { createdAt: "desc" },
        /** Teto para a resposta não crescer sem limite: a rota monta tudo em memória. */
        take: 500,
        select: { createdAt: true, action: true, actorRole: true, entityId: true, actorId: true },
      })
    : [];

  const doc = decryptField(user.documentEnc);
  const payload = {
    exportadoEm: new Date().toISOString(),
    perfil: {
      nome: user.name,
      email: user.email,
      telefone: user.phone,
      documento: doc ? maskDocument(doc) : null, // mascarado por segurança
      criadoEm: user.createdAt,
    },
    consentimentos: user.consents,
    analises: user.analyses,
    chamados: user.ticketsOpened,
    acessos: acessos.map((a) => ({
      quando: a.createdAt,
      acao: a.action,
      /** Papel, nunca a pessoa. Ver o comentário acima. */
      perfilDeQuemAcessou: a.actorRole ?? "sistema",
      analiseId: a.entityId,
      /** Distingue o acesso do próprio titular do acesso da equipe, sem identificar o funcionário. */
      foiVoce: a.actorId === user.id,
    })),
  };

  await logAudit({ actorId: user.id, action: "account.export" });
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="meus-dados.json"`,
      "Cache-Control": "private, no-store",
    },
  });
});
