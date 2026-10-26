import type { AnalysisStatus, SubscriptionStatus, ConfidenceLevel } from "@prisma/client";

/**
 * Tons dos selos. O tom "neutro" acompanha o tema pela escala neutra; os
 * demais usam fundos coloridos fixos e por isso declaram variante `dark:`
 * própria (fundo translúcido + texto claro) para manter contraste no escuro.
 */
const STATUS_STYLE: Record<string, string> = {
  neutro: "bg-neutro-100 text-neutro-700",
  info: "bg-marca-50 text-marca-700 dark:bg-marca-500/20 dark:text-marca-200",
  sucesso: "bg-sucesso-100 text-sucesso dark:bg-sucesso/25 dark:text-sucesso-50",
  atencao: "bg-atencao-100 text-atencao dark:bg-atencao/25 dark:text-atencao-50",
  alerta: "bg-alerta-100 text-alerta-700 dark:bg-alerta-500/25 dark:text-alerta-100",
};

export function Badge({ tone = "neutro", children }: { tone?: keyof typeof STATUS_STYLE; children: React.ReactNode }) {
  return <span className={`badge ${STATUS_STYLE[tone]}`}>{children}</span>;
}

const ANALYSIS_LABEL: Record<AnalysisStatus, { label: string; tone: keyof typeof STATUS_STYLE }> = {
  RASCUNHO: { label: "Rascunho", tone: "neutro" },
  DOCUMENTOS_ENVIADOS: { label: "Documentos enviados", tone: "info" },
  VALIDANDO_DOCUMENTOS: { label: "Validando", tone: "info" },
  EXTRAINDO_INFORMACOES: { label: "Extraindo", tone: "info" },
  PROCESSANDO: { label: "Processando", tone: "info" },
  AGUARDANDO_INFORMACOES: { label: "Aguardando informações", tone: "atencao" },
  AGUARDANDO_REVISAO: { label: "Aguardando revisão", tone: "atencao" },
  EM_REVISAO: { label: "Em revisão", tone: "atencao" },
  CONCLUIDA: { label: "Concluída", tone: "sucesso" },
  ERRO_PROCESSAMENTO: { label: "Erro", tone: "alerta" },
  CANCELADA: { label: "Cancelada", tone: "neutro" },
  ARQUIVADA: { label: "Arquivada", tone: "neutro" },
};

export function AnalysisStatusBadge({ status }: { status: AnalysisStatus }) {
  const s = ANALYSIS_LABEL[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const SUB_LABEL: Record<SubscriptionStatus, { label: string; tone: keyof typeof STATUS_STYLE }> = {
  TESTE: { label: "Teste", tone: "info" },
  ATIVA: { label: "Ativa", tone: "sucesso" },
  VENCIDA: { label: "Vencida", tone: "atencao" },
  CANCELADA: { label: "Cancelada", tone: "neutro" },
  SUSPENSA: { label: "Suspensa", tone: "alerta" },
  INADIMPLENTE: { label: "Inadimplente", tone: "alerta" },
  ESTORNADA: { label: "Estornada", tone: "alerta" },
};

export function SubscriptionStatusBadge({ status }: { status: SubscriptionStatus }) {
  const s = SUB_LABEL[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const CONF_LABEL: Record<ConfidenceLevel, { label: string; tone: keyof typeof STATUS_STYLE }> = {
  ALTO: { label: "Confiança alta", tone: "sucesso" },
  MEDIO: { label: "Confiança média", tone: "atencao" },
  BAIXO: { label: "Confiança baixa", tone: "alerta" },
  INDETERMINADO: { label: "Indeterminado", tone: "neutro" },
};

export function ConfidenceBadge({ level }: { level: ConfidenceLevel }) {
  const s = CONF_LABEL[level];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
