import { prisma } from "./db";
import { alertarOperacao } from "./alerta-operacional";

/**
 * Retenção de dados pessoais: os prazos publicados e a parte deles que é
 * EXECUTADA por código.
 *
 * ── Por que este módulo existe ────────────────────────────────────────────────
 * A Política de Privacidade publica uma tabela de prazos (seção 9) e admite, na
 * seção 9.1, que não havia rotina executando nenhum deles — a eliminação era
 * "procedimento do Encarregado", sem sequer um relatório do que venceu. A
 * auditoria LGPD de set/2026 mediu a consequência: Session, AuditLog e
 * SecurityEvent cresciam para sempre, inclusive IP e User-Agent de sessões
 * revogadas há anos.
 *
 * ── A fonte única dos números ─────────────────────────────────────────────────
 * `RETENCAO` morava DUPLICADA em cancelamento/page.tsx (a fonte) e
 * privacidade/page.tsx (cópia com comentário apontando a fonte). Mesmo remédio
 * do PRAZO_RESPOSTA_TITULAR_DIAS: os documentos passam a importar daqui, e o
 * código que executa lê a MESMA constante — não há como o documento prometer um
 * número e a rotina aplicar outro.
 *
 * DECISÃO PARA O DONO CONFERIR (herdada da página): `conteudoMeses` é o prazo em
 * que os autos enviados e as análises sobrevivem ao encerramento. Seis meses é a
 * posição mais defensável (necessidade — art. 6º, III, da LGPD — sobre material
 * coberto por sigilo profissional de terceiros). Doze seria mais confortável
 * comercialmente e exigiria só trocar o número aqui.
 *
 * ── O que EXECUTA e o que fica com o Encarregado ──────────────────────────────
 * Executa (nesta ordem de certeza):
 *   1. Session: linha expirada ou revogada há mais de `logAcessoMeses`. O
 *      registro de acesso do art. 15 do Marco Civil NÃO mora aqui — mora no
 *      AuditLog `auth.login`, que sobrevive — então apagar a linha morta da
 *      sessão (com tokenHash, IP e User-Agent) não toca a obrigação legal.
 *   2. AuditLog e SecurityEvent além de `auditoriaAnos` — o teto que a própria
 *      política publica. O piso do Marco Civil (6 meses) fica coberto por
 *      construção: 5 anos > 6 meses.
 *
 * NÃO executa, de propósito:
 *   - `Consent`: há uma contradição pendente de VALIDAÇÃO JURÍDICA (a política
 *     promete guardar o registro dos aceites por 5 anos como prova, e a exclusão
 *     de conta o apaga em cascata). Até essa decisão, este módulo não encosta.
 *   - `conteudoMeses` e `cadastroAnos`: dependem de uma definição de
 *     "encerramento" que o schema não tem num campo único (Subscription tem
 *     status + currentPeriodEnd, e conta sem assinatura nunca teve ciclo).
 *     Automatizar em cima de adivinhação apagaria análise de cliente vivo.
 *     Seguem sendo procedimento do Encarregado (política, seção 9.1) — decisão
 *     de modelagem para a próxima fase.
 */
export const RETENCAO = {
  /** Autos enviados, texto extraído, análises, relatórios e minutas. */
  conteudoMeses: 6,
  /** Cadastro e conta. */
  cadastroAnos: 5,
  /** Registro financeiro e fiscal da venda. */
  fiscalAnos: 5,
  /** Registros de acesso: piso legal do art. 15 do Marco Civil da Internet. */
  logAcessoMeses: 6,
  /** Trilha de auditoria e eventos de segurança. */
  auditoriaAnos: 5,
} as const;

/** Marcador da execução na trilha — também serve de prova de que a rotina roda. */
export const ACAO_RETENCAO = "lgpd.retencao_executada";

export interface ResultadoRetencao {
  sessoesApagadas: number;
  auditoriaApagada: number;
  segurancaApagada: number;
}

/**
 * Aplica os prazos executáveis. Idempotente: a segunda passada do dia apaga zero.
 *
 * `agora` é injetável pelos testes — mesmo padrão de vigiarPrazosDoTitular.
 */
export async function executarRetencao(agora: Date = new Date()): Promise<ResultadoRetencao> {
  const corteSessao = new Date(agora.getTime() - RETENCAO.logAcessoMeses * 30 * 86_400_000);
  const corteAuditoria = new Date(agora.getTime() - RETENCAO.auditoriaAnos * 365 * 86_400_000);

  const sessoes = await prisma.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: corteSessao } },
        { revokedAt: { lt: corteSessao } },
      ],
    },
  });

  // O próprio marcador ACAO_RETENCAO também envelhece e cai pelo mesmo teto —
  // sem carve-out: cinco anos de "a rotina rodou" é mais do que qualquer
  // investigação vai pedir.
  const auditoria = await prisma.auditLog.deleteMany({
    where: { createdAt: { lt: corteAuditoria } },
  });
  const seguranca = await prisma.securityEvent.deleteMany({
    where: { createdAt: { lt: corteAuditoria } },
  });

  const r: ResultadoRetencao = {
    sessoesApagadas: sessoes.count,
    auditoriaApagada: auditoria.count,
    segurancaApagada: seguranca.count,
  };

  // Registra a execução SEMPRE — inclusive com tudo zero. "Rodou e nada estava
  // vencido" é informação; silêncio seria indistinguível de rotina morta, que é
  // exatamente o defeito que este módulo corrige.
  await prisma.auditLog.create({
    data: {
      actorId: null,
      action: ACAO_RETENCAO,
      metadata: {
        ...r,
        prazos: {
          sessaoMeses: RETENCAO.logAcessoMeses,
          auditoriaAnos: RETENCAO.auditoriaAnos,
        },
      },
    },
  });

  // Alerta só quando o teto de 5 anos derruba algo: é raro por natureza (só
  // acontece quando o sistema completa a idade), e o Encarregado deve saber.
  // O expurgo de sessão é rotina de higiene — viraria ruído diário.
  if (r.auditoriaApagada > 0 || r.segurancaApagada > 0) {
    await alertarOperacao({
      tipo: "lgpd_retencao_teto_auditoria",
      assunto: `Retenção: ${r.auditoriaApagada + r.segurancaApagada} registro(s) além de ${RETENCAO.auditoriaAnos} anos expurgados`,
      linhas: [
        `Trilha de auditoria: ${r.auditoriaApagada} registro(s).`,
        `Eventos de segurança: ${r.segurancaApagada} registro(s).`,
        `É o teto de ${RETENCAO.auditoriaAnos} anos publicado na Política de Privacidade (seção 9), aplicado automaticamente.`,
      ],
      acao: "Nada a fazer — este aviso existe para o expurgo nunca ser surpresa.",
      metadata: { source: "lgpd", ...r },
    });
  }

  return r;
}
