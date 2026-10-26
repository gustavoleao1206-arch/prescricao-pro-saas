import type { Role } from "@prisma/client";

/**
 * Controle de acesso baseado em papéis (RBAC).
 * As permissões são declaradas por papel e verificadas no servidor.
 * O isolamento por organização/usuário é reforçado nas queries (ver data-access).
 */

export type Permission =
  // Cliente
  | "analysis:create"
  | "analysis:read:own"
  | "analysis:update:own"
  | "document:upload"
  | "report:download:own"
  | "petition:download:own"
  | "support:open"
  | "account:manage:own"
  // Revisor jurídico
  | "review:read"
  | "review:decide"
  | "timeline:edit"
  | "petition:edit"
  // Suporte
  | "support:handle"
  | "user:read:basic"
  // Administrador
  | "user:manage"
  | "plan:manage"
  | "subscription:manage"
  | "content:manage"
  | "knowledge:manage"
  | "prompt:manage"
  | "integration:manage"
  | "audit:read"
  | "analysis:read:all"
  | "data:delete"
  | "data:anonymize";

const MATRIX: Record<Role, Permission[]> = {
  CLIENTE: [
    "analysis:create",
    "analysis:read:own",
    "analysis:update:own",
    "document:upload",
    "report:download:own",
    "petition:download:own",
    "support:open",
    "account:manage:own",
  ],
  REVISOR: [
    "analysis:read:own",
    /**
     * ⚠️ ACRESCENTADO PARA A MATRIZ DIZER A VERDADE — não para ampliar acesso.
     *
     * O código já dava leitura irrestrita ao REVISOR (`src/lib/tenant.ts`), e esta matriz dizia o
     * contrário. Documento que afirma o oposto do que o sistema faz é pior do que documento nenhum: quem
     * auditar — a ANPD, um cliente corporativo, o advogado da parte contrária — lê aqui que o revisor só vê
     * o que é dele, e essa conclusão está errada.
     *
     * ⚠️ DECISÃO DE NEGÓCIO PENDENTE PARA O DONO: restringir o revisor às análises que lhe foram
     * DESIGNADAS. Não existe designação no sistema hoje — `LegalReview.reviewerId` só é preenchido quando a
     * revisão é decidida. Ligar a restrição sem antes criar e popular a designação travaria a fila
     * "Aguardando revisão" inteira. Feita a designação, restringir é apagar esta linha: `tenant.ts` já
     * consulta esta matriz.
     */
    "analysis:read:all",
    "review:read",
    "review:decide",
    "timeline:edit",
    "petition:edit",
    "report:download:own",
  ],
  SUPORTE: ["support:handle", "user:read:basic"],
  ADMIN: [
    // Admin possui todas as permissões.
    "analysis:create",
    "analysis:read:own",
    "analysis:read:all",
    "analysis:update:own",
    "document:upload",
    "report:download:own",
    "petition:download:own",
    "support:open",
    "support:handle",
    "account:manage:own",
    "review:read",
    "review:decide",
    "timeline:edit",
    "petition:edit",
    "user:read:basic",
    "user:manage",
    "plan:manage",
    "subscription:manage",
    "content:manage",
    "knowledge:manage",
    "prompt:manage",
    "integration:manage",
    "audit:read",
    "data:delete",
    "data:anonymize",
  ],
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role]?.includes(permission) ?? false;
}

export function permissionsFor(role: Role): Permission[] {
  return MATRIX[role] ?? [];
}
