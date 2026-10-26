import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * A retenção que EXECUTA — expurgo de sessões mortas e o teto da auditoria.
 *
 * ── O defeito ─────────────────────────────────────────────────────────────────
 * A Política de Privacidade publica prazos (seção 9) e admitia, na 9.1, que
 * nenhum era executado por código: Session, AuditLog e SecurityEvent cresciam
 * para sempre — inclusive IP e User-Agent de sessão revogada há anos. Este teste
 * prova que a rotina apaga EXATAMENTE o que venceu, e nada além:
 *
 * - sessão expirada/revogada há mais de 6 meses cai; recente ou ativa fica;
 * - auditoria e eventos de segurança além de 5 anos caem; abaixo, ficam
 *   (o piso do art. 15 do Marco Civil — 6 meses — está coberto por 5 >> 0,5);
 * - Consent NÃO é tocado: há validação jurídica pendente sobre ele
 *   (prova do aceite × cascata da exclusão), e até lá a rotina não encosta;
 * - a execução deixa marcador na trilha mesmo quando apaga zero — silêncio
 *   seria indistinguível de rotina morta.
 */

const { executarRetencao, RETENCAO, ACAO_RETENCAO } = await import("../src/lib/retencao");

const prisma = new PrismaClient();
const PREFIXO = "test-retencao";

function diasAtras(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

async function limpar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIXO } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.consent.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.auditLog.deleteMany({ where: { action: ACAO_RETENCAO } });
  await prisma.securityEvent.deleteMany({ where: { email: { startsWith: PREFIXO } } });
}

beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

async function conta(sufixo: string) {
  return prisma.user.create({
    data: {
      email: `${PREFIXO}-${sufixo}@exemplo.local`,
      name: `Retencao ${sufixo}`,
      passwordHash: "x",
      role: "CLIENTE",
      status: "ATIVO",
    },
  });
}

function sessao(userId: string, sufixo: string, dados: { expiresAt: Date; revokedAt?: Date | null }) {
  return prisma.session.create({
    data: {
      userId,
      tokenHash: `${PREFIXO}-${sufixo}-${Math.random().toString(36).slice(2)}`,
      ip: "203.0.113.7",
      userAgent: "teste",
      expiresAt: dados.expiresAt,
      revokedAt: dados.revokedAt ?? null,
    },
  });
}

describe("executarRetencao", () => {
  it("apaga sessão morta há mais de 6 meses e preserva as demais", async () => {
    const u = await conta("sessoes");
    const morta = await sessao(u.id, "expirada-antiga", { expiresAt: diasAtras(220) });
    const revogada = await sessao(u.id, "revogada-antiga", {
      expiresAt: diasAtras(200),
      revokedAt: diasAtras(210),
    });
    const recente = await sessao(u.id, "expirada-recente", { expiresAt: diasAtras(30) });
    const ativa = await sessao(u.id, "ativa", { expiresAt: new Date(Date.now() + 86_400_000) });

    const r = await executarRetencao();

    const vivas = await prisma.session.findMany({ where: { userId: u.id }, select: { id: true } });
    const idsVivos = vivas.map((s) => s.id).sort();
    expect(idsVivos).toEqual([ativa.id, recente.id].sort());
    expect(r.sessoesApagadas).toBeGreaterThanOrEqual(2);
    // e as apagadas eram exatamente a expirada e a revogada antigas
    expect(idsVivos).not.toContain(morta.id);
    expect(idsVivos).not.toContain(revogada.id);
  });

  it("aplica o teto de 5 anos na auditoria e nos eventos de segurança — e só nele", async () => {
    const u = await conta("teto");
    const antigo = await prisma.auditLog.create({
      data: { actorId: u.id, action: "auth.login", entityId: u.id, ip: "203.0.113.7", createdAt: diasAtras(6 * 365) },
    });
    const novo = await prisma.auditLog.create({
      data: { actorId: u.id, action: "auth.login", entityId: u.id, ip: "203.0.113.7", createdAt: diasAtras(4 * 365) },
    });
    const evAntigo = await prisma.securityEvent.create({
      data: { type: "login_failed", email: `${PREFIXO}-teto@exemplo.local`, createdAt: diasAtras(6 * 365) },
    });
    const evNovo = await prisma.securityEvent.create({
      data: { type: "login_failed", email: `${PREFIXO}-teto@exemplo.local`, createdAt: diasAtras(30) },
    });

    const r = await executarRetencao();

    expect(await prisma.auditLog.findUnique({ where: { id: antigo.id } })).toBeNull();
    expect(await prisma.auditLog.findUnique({ where: { id: novo.id } })).not.toBeNull();
    expect(await prisma.securityEvent.findUnique({ where: { id: evAntigo.id } })).toBeNull();
    expect(await prisma.securityEvent.findUnique({ where: { id: evNovo.id } })).not.toBeNull();
    expect(r.auditoriaApagada).toBeGreaterThanOrEqual(1);
    expect(r.segurancaApagada).toBeGreaterThanOrEqual(1);
  });

  it("não encosta em Consent, mesmo antigo — validação jurídica pendente", async () => {
    const u = await conta("consent");
    const c = await prisma.consent.create({
      data: {
        userId: u.id,
        type: "TERMOS_USO",
        version: "teste-1",
        ip: "203.0.113.7",
        grantedAt: diasAtras(6 * 365),
      },
    });
    await executarRetencao();
    expect(await prisma.consent.findUnique({ where: { id: c.id } })).not.toBeNull();
  });

  it("registra a execução na trilha mesmo com tudo zero, e é idempotente", async () => {
    const r1 = await executarRetencao();
    const marcadores = await prisma.auditLog.findMany({ where: { action: ACAO_RETENCAO } });
    expect(marcadores.length).toBe(1);
    expect((marcadores[0]?.metadata as Record<string, unknown>)?.prazos).toBeTruthy();

    const r2 = await executarRetencao();
    expect(r2.sessoesApagadas).toBe(0);
    expect(r2.auditoriaApagada).toBe(0);
    expect(r2.segurancaApagada).toBe(0);
    expect(r1).toBeTruthy();
  });

  it("os prazos publicados são os executados — a constante é uma só", () => {
    // Se alguém mudar o número no documento sem mudar aqui (ou vice-versa),
    // não compila/não passa: as páginas importam ESTA constante.
    expect(RETENCAO.logAcessoMeses).toBe(6);
    expect(RETENCAO.auditoriaAnos).toBe(5);
  });
});
