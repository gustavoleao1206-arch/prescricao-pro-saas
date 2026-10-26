import { prisma } from "./db";
import type { Prisma, Role } from "@prisma/client";

/**
 * Trilha de auditoria e eventos de segurança.
 * Nunca registrar senhas, tokens, chaves ou conteúdo integral de documentos.
 * O metadata deve conter apenas dados NÃO sensíveis, úteis para investigação.
 */

interface AuditInput {
  actorId?: string | null;
  actorRole?: Role | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

export async function logAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? undefined,
        actorRole: input.actorRole ?? undefined,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: sanitize(input.metadata),
        ip: input.ip,
        userAgent: input.userAgent?.slice(0, 300),
      },
    });
  } catch (err) {
    // Auditoria nunca deve quebrar o fluxo principal.
    console.error("[audit] falha ao registrar", (err as Error).message);
    /**
     * ⚠️ A FALHA DEIXA DE SER INVISÍVEL.
     *
     * Engolir o erro está certo e continua: derrubar o download de um documento porque a auditoria não
     * gravou seria pior do que a lacuna. O problema era outro — a lacuna não aparecia em lugar nenhum
     * além do log do servidor.
     *
     * Por que isso importa juridicamente: a trilha é o ÚNICO controle que o produto oferece em troca do
     * acesso técnico irrestrito de ADMIN e REVISOR, e os Termos e a Política dizem isso com essas
     * palavras. Numa apuração, a ausência de linha é ambígua entre "ninguém acessou" e "acessou e o
     * registro caiu" — e essa ambiguidade pesa contra quem tinha o dever de registrar.
     *
     * `SecurityEvent` é outra tabela e outro caminho de escrita, então tende a sobreviver quando o INSERT
     * em `AuditLog` falha por conflito ou por índice. Se o banco inteiro estiver fora, esta chamada também
     * falha e o `catch` dela engole — não há laço infinito, e não há registro. Isso está aceito e escrito
     * aqui de propósito: com o banco fora, não existe onde registrar.
     */
    await logSecurityEvent({
      type: "auditoria_nao_registrada",
      metadata: { acao: input.action, entityType: input.entityType, entityId: input.entityId },
    }).catch(() => {});
  }
}

/**
 * Minutos de folga entre dois registros da MESMA leitura pelo MESMO leitor.
 *
 * A tela de análise chama `router.refresh()` a cada 4 segundos enquanto o processamento corre, e cada
 * atualização reexecuta o componente de servidor. Sem folga, uma análise de 10 minutos gravaria ~150 linhas
 * idênticas por leitor — trilha que ninguém consegue ler é trilha que não serve, e ainda enche o banco do
 * plano mais barato do Render.
 *
 * 15 minutos é a mesma ordem de grandeza que o projeto já usa para regravar o `lastSeenAt` da sessão.
 */
const FOLGA_DA_LEITURA_MINUTOS = 15;

/**
 * Registra a LEITURA de um item, no máximo uma vez por leitor a cada 15 minutos.
 *
 * ── Por que registrar leitura, e por que registrar a de todo mundo ────────────
 * A LGPD (art. 6, X, e art. 37) cobra poder DEMONSTRAR as operações de tratamento. "Quem leu a análise do
 * cliente X" era, até aqui, uma pergunta sem resposta: ADMIN e REVISOR leem o processo completo de qualquer
 * assinante — os autos de execução fiscal, sob sigilo profissional — e nada ficava gravado.
 *
 * Registra também a leitura do PRÓPRIO dono, e isso é decisão consciente: trilha que só grava o acesso de
 * terceiro revela, por omissão, quando alguém de fora entrou; e a leitura do dono é a linha que dá contexto
 * ao resto ("o cliente abriu 40 vezes, a equipe abriu 1" conta uma história diferente de uma linha só).
 *
 * Devolve `true` quando gravou, `false` quando a folga suprimiu — útil para teste.
 */
export async function logLeitura(input: {
  actorId: string;
  actorRole?: Role | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}): Promise<boolean> {
  try {
    const desde = new Date(Date.now() - FOLGA_DA_LEITURA_MINUTOS * 60_000);
    /**
     * Consulta barata: `AuditLog` já tem índice em [entityType, entityId]. Filtra por ator E entidade —
     * nunca por `action` sozinho, senão a leitura de uma análise suprimiria a de outra.
     */
    const recente = await prisma.auditLog.findFirst({
      where: {
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        createdAt: { gte: desde },
      },
      select: { id: true },
    });
    if (recente) return false;
  } catch {
    /** Falhou a consulta da folga: registra de todo jeito. Linha repetida é melhor do que linha ausente. */
  }

  await logAudit(input);
  return true;
}

interface SecurityInput {
  type: string;
  email?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

export async function logSecurityEvent(input: SecurityInput): Promise<void> {
  try {
    await prisma.securityEvent.create({
      data: {
        type: input.type,
        email: input.email,
        ip: input.ip,
        userAgent: input.userAgent?.slice(0, 300),
        metadata: sanitize(input.metadata),
      },
    });
  } catch (err) {
    console.error("[security] falha ao registrar", (err as Error).message);
  }
}

// Remove chaves potencialmente sensíveis por precaução.
const BLOCKLIST = ["password", "senha", "token", "secret", "authorization", "cpf", "cnpj", "documento"];
function sanitize(meta?: Record<string, unknown>): Prisma.InputJsonValue | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (BLOCKLIST.some((b) => k.toLowerCase().includes(b))) {
      out[k] = "[REDIGIDO]";
    } else {
      out[k] = v;
    }
  }
  return out as Prisma.InputJsonValue;
}
