import { prisma } from "./db";
import { getSessionUser, requireUser, type SessionUser } from "./auth";
import {
  getCurrentSubscription,
  subscriptionAccess,
  quotaStatus,
  type QuotaStatus,
  type SubscriptionAccess,
} from "./consumption";
import { SubscriptionError } from "./api";
import type { Organization, Subscription } from "@prisma/client";
import { can } from "./rbac";

/**
 * Contexto do cliente autenticado, com isolamento por organização.
 * Toda leitura de dados sensíveis deve derivar do organizationId retornado aqui.
 */
export interface AppContext {
  user: SessionUser;
  organization: Organization | null;
  /** Assinatura que CONCEDE acesso agora (ATIVA/TESTE no prazo ou carência). Null caso contrário. */
  subscription: Subscription | null;
  /** Assinatura mais recente, QUALQUER status — para exibição na área do cliente. */
  currentSubscription: Subscription | null;
  /** Decisão de acesso derivada (hasAccess + motivo + mensagem). */
  access: SubscriptionAccess;
  quota: QuotaStatus;
}

/**
 * A organização desta conta, criando-a se ainda não existir.
 *
 * ── Por que existe, e por que aqui ────────────────────────────────────────────
 * Toda leitura de dado do cliente deriva da organização — é ela que isola um escritório
 * do outro. Só que a organização nascia em TRÊS lugares com o mesmo código copiado: no
 * cadastro pelo site, no webhook do Asaas (primeira aprovação de pagamento) e na
 * liberação manual pelo painel. Três cópias da mesma regra é como as três divergem.
 *
 * E havia um quarto lugar que precisava dela e simplesmente RECUSAVA: as rotas de criar
 * análise devolviam "Organização não encontrada" para toda conta que não tivesse passado
 * por um daqueles três caminhos — o ADMIN da semente, um REVISOR, um SUPORTE. A conta
 * existia, estava autenticada, e não conseguia criar análise nenhuma. Recusar era
 * estranho justamente porque criar a organização é barato, automático nos outros
 * caminhos, e não depende de decisão de ninguém.
 *
 * `orgRole: "OWNER"` acompanha a criação porque quem cria a própria organização é o
 * titular dela; sem isso a conta ficaria ligada a uma organização em que não tem papel.
 */
export async function garantirOrganizacao(
  userId: string,
  nomeSugerido: string,
): Promise<Organization> {
  const existente = await prisma.organization.findFirst({ where: { ownerId: userId } });
  if (existente) return existente;

  const org = await prisma.organization.create({ data: { name: nomeSugerido, ownerId: userId } });
  await prisma.user.update({ where: { id: userId }, data: { organizationId: org.id, orgRole: "OWNER" } });
  return org;
}

export async function getAppContext(): Promise<AppContext | null> {
  const user = await getSessionUser();
  if (!user) return null;
  const organization = user.organizationId
    ? await prisma.organization.findUnique({ where: { id: user.organizationId } })
    : await prisma.organization.findFirst({ where: { ownerId: user.id } });
  const currentSubscription = organization ? await getCurrentSubscription(organization.id) : null;
  const access = subscriptionAccess(currentSubscription);
  const subscription = access.hasAccess ? currentSubscription : null;
  return { user, organization, subscription, currentSubscription, access, quota: quotaStatus(subscription) };
}

export async function requireAppContext(): Promise<AppContext> {
  await requireUser();
  const ctx = await getAppContext();
  if (!ctx) throw new Error("Contexto do usuário indisponível.");
  return ctx;
}

/**
 * Gate central de assinatura (validação NO SERVIDOR). Lança SubscriptionError (402)
 * com mensagem clara quando o acesso ao agente não está liberado. Deve envolver toda
 * operação do agente: processar análise, gerar/baixar relatório e peça, subir documento.
 *
 * Apenas o papel CLIENTE depende de assinatura. Papéis internos da equipe
 * (ADMIN, REVISOR, SUPORTE) são isentos para não quebrar os fluxos de revisão/suporte.
 */
export function assertActiveSubscription(ctx: AppContext): void {
  if (ctx.user.role !== "CLIENTE") return;
  if (!ctx.access.hasAccess) {
    throw new SubscriptionError(ctx.access.message, ctx.access.reason);
  }
}

/**
 * Carrega uma análise garantindo que pertence ao usuário/organização.
 * Admin pode ler todas; demais papéis, apenas as próprias/da organização.
 */
export async function getAnalysisForContext(analysisId: string, ctx: AppContext, includeAll = false) {
  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    include: includeAll
      ? {
          documents: { where: { deletedAt: null } },
          timeline: { orderBy: { eventDate: "asc" } },
          reports: { orderBy: { version: "desc" } },
          petitions: { orderBy: { createdAt: "desc" } },
          review: true,
        }
      : undefined,
  });
  if (!analysis) return null;

  const isOwner = analysis.ownerId === ctx.user.id;
  const sameOrg = ctx.organization && analysis.organizationId === ctx.organization.id;
  /**
   * ⚠️ A regra vem da MATRIZ, não de comparação de papéis escrita aqui.
   *
   * Antes havia duas fontes: esta linha comparava papéis à mão, e `src/lib/rbac.ts` declarava uma matriz de
   * permissões que ninguém consultava — `can()` não tinha um único chamador no projeto. As duas divergiam, e
   * a que valia era esta. Código que ninguém executa não é controle; matriz que ninguém consulta é enfeite.
   *
   * O comportamento é IDÊNTICO ao de antes (ADMIN e REVISOR têm `analysis:read:all`). O que muda é que agora
   * existe um lugar só: restringir o revisor passa a ser apagar uma linha da matriz.
   */
  const privileged = can(ctx.user.role, "analysis:read:all");
  if (!isOwner && !sameOrg && !privileged) return null;

  return analysis;
}
