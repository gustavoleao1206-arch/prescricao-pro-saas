-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'CLIENTE', 'REVISOR', 'SUPORTE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDENTE_VERIFICACAO', 'ATIVO', 'BLOQUEADO', 'SUSPENSO');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBRO');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MENSAL', 'ANUAL', 'PACOTE', 'UNICO');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TESTE', 'ATIVA', 'VENCIDA', 'CANCELADA', 'SUSPENSA', 'INADIMPLENTE', 'ESTORNADA');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('HOTMART', 'MANUAL', 'STRIPE', 'OUTRO');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('APROVADO', 'PENDENTE', 'RECUSADO', 'ESTORNADO', 'CHARGEBACK', 'CANCELADO');

-- CreateEnum
CREATE TYPE "HotmartEventStatus" AS ENUM ('RECEBIDO', 'PROCESSADO', 'IGNORADO', 'ERRO');

-- CreateEnum
CREATE TYPE "AnalysisType" AS ENUM ('PRESCRICAO', 'DECADENCIA', 'PRESCRICAO_INTERCORRENTE', 'EXECUCAO_FISCAL_COMPLETA', 'NULIDADES', 'GERAL');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('RASCUNHO', 'DOCUMENTOS_ENVIADOS', 'VALIDANDO_DOCUMENTOS', 'EXTRAINDO_INFORMACOES', 'PROCESSANDO', 'AGUARDANDO_INFORMACOES', 'AGUARDANDO_REVISAO', 'EM_REVISAO', 'CONCLUIDA', 'ERRO_PROCESSAMENTO', 'CANCELADA', 'ARQUIVADA');

-- CreateEnum
CREATE TYPE "ConfidenceLevel" AS ENUM ('ALTO', 'MEDIO', 'BAIXO', 'INDETERMINADO');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('RECEBIDO', 'VALIDANDO', 'PROCESSADO', 'ILEGIVEL', 'RECUSADO', 'EXCLUIDO');

-- CreateEnum
CREATE TYPE "TimelineEventType" AS ENUM ('CONSTITUICAO_CREDITO', 'INSCRICAO_DIVIDA_ATIVA', 'AJUIZAMENTO', 'DESPACHO_CITATORIO', 'CITACAO', 'PARCELAMENTO', 'SUSPENSAO', 'ARQUIVAMENTO', 'PENHORA', 'GARANTIA', 'MANIFESTACAO', 'DECISAO', 'DILIGENCIA', 'POSSIVEL_INTERRUPTIVO', 'POSSIVEL_SUSPENSIVO', 'SEM_EFEITO_DEFINIDO');

-- CreateEnum
CREATE TYPE "FactNature" AS ENUM ('FATO_CONFIRMADO', 'INTERPRETACAO', 'HIPOTESE', 'PENDENTE');

-- CreateEnum
CREATE TYPE "PetitionType" AS ENUM ('EXCECAO_PRE_EXECUTIVIDADE', 'EMBARGOS_EXECUCAO_FISCAL', 'RECONHECIMENTO_PRESCRICAO', 'PRESCRICAO_INTERCORRENTE', 'MANIFESTACAO_DECADENCIA', 'PEDIDO_EXTINCAO', 'RELATORIO_JURIDICO', 'PARECER_PRELIMINAR', 'PETICAO_SIMPLES', 'REQUERIMENTO_DILIGENCIAS', 'RECONHECIMENTO_NULIDADE');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDENTE', 'EM_ANALISE', 'APROVADA', 'DEVOLVIDA');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('ABERTO', 'EM_ATENDIMENTO', 'AGUARDANDO_CLIENTE', 'RESOLVIDO', 'ENCERRADO');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('BAIXA', 'MEDIA', 'ALTA', 'URGENTE');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('TERMOS_USO', 'POLITICA_PRIVACIDADE', 'USO_IA', 'COOKIES');

-- CreateEnum
CREATE TYPE "KnowledgeCategory" AS ENUM ('CONSTITUICAO_FEDERAL', 'CODIGO_TRIBUTARIO_NACIONAL', 'LEI_EXECUCOES_FISCAIS', 'CODIGO_PROCESSO_CIVIL', 'JURISPRUDENCIA_STF', 'JURISPRUDENCIA_STJ', 'TEMAS_REPETITIVOS', 'SUMULAS', 'MANUAIS', 'DOUTRINA', 'LEGISLACAO_COMPLEMENTAR', 'MODELOS_PECAS', 'MODELOS_RELATORIOS', 'ORIENTACOES_INTERNAS', 'MATERIAIS_PROPRIETARIO');

-- CreateEnum
CREATE TYPE "PromptKind" AS ENUM ('SISTEMA_ANALISE', 'EXTRACAO_EVENTOS', 'LINHA_DO_TEMPO', 'RELATORIO', 'PECA_JURIDICA', 'VALIDACAO');

-- CreateEnum
CREATE TYPE "TokenType" AS ENUM ('VERIFICACAO_EMAIL', 'RECUPERACAO_SENHA', 'CRIACAO_SENHA', 'CONVITE_MEMBRO');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "passwordHash" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "documentEnc" TEXT,
    "documentType" TEXT,
    "role" "Role" NOT NULL DEFAULT 'CLIENTE',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDENTE_VERIFICACAO',
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "twoFactorPendingSecret" TEXT,
    "twoFactorBackupCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "organizationId" TEXT,
    "orgRole" "OrgRole",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "documentEnc" TEXT,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "TokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "period" "BillingPeriod" NOT NULL DEFAULT 'MENSAL',
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "monthlyAnalyses" INTEGER NOT NULL DEFAULT 0,
    "maxUsers" INTEGER NOT NULL DEFAULT 1,
    "storageMb" INTEGER NOT NULL DEFAULT 1024,
    "maxFileMb" INTEGER NOT NULL DEFAULT 25,
    "allowReports" BOOLEAN NOT NULL DEFAULT true,
    "allowPetitions" BOOLEAN NOT NULL DEFAULT true,
    "priorityProcessing" BOOLEAN NOT NULL DEFAULT false,
    "supportLevel" TEXT NOT NULL DEFAULT 'padrao',
    "hotmartOfferCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "features" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TESTE',
    "provider" "PaymentProvider" NOT NULL DEFAULT 'HOTMART',
    "externalRef" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodEnd" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "analysesUsed" INTEGER NOT NULL DEFAULT 0,
    "analysesQuota" INTEGER NOT NULL DEFAULT 0,
    "extraAnalyses" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'HOTMART',
    "externalId" TEXT,
    "status" "PaymentStatus" NOT NULL,
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "paidAt" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HotmartEvent" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" "HotmartEventStatus" NOT NULL DEFAULT 'RECEBIDO',
    "buyerEmail" TEXT,
    "offerCode" TEXT,
    "productId" TEXT,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HotmartEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "AnalysisType" NOT NULL DEFAULT 'GERAL',
    "status" "AnalysisStatus" NOT NULL DEFAULT 'RASCUNHO',
    "objective" TEXT,
    "processNumber" TEXT,
    "court" TEXT,
    "jurisdiction" TEXT,
    "courtDivision" TEXT,
    "creditor" TEXT,
    "debtor" TEXT,
    "debtorDocEnc" TEXT,
    "taxType" TEXT,
    "publicEntity" TEXT,
    "cdaNumber" TEXT,
    "dividaAtivaNumber" TEXT,
    "approxValueCents" INTEGER,
    "facts" JSONB,
    "confidence" "ConfidenceLevel" NOT NULL DEFAULT 'INDETERMINADO',
    "aiModel" TEXT,
    "promptVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "analysisId" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'RECEBIDO',
    "pageCount" INTEGER,
    "ocrApplied" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentPage" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "legible" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "DocumentPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimelineEvent" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "eventDate" TIMESTAMP(3),
    "dateText" TEXT,
    "type" "TimelineEventType" NOT NULL DEFAULT 'SEM_EFEITO_DEFINIDO',
    "nature" "FactNature" NOT NULL DEFAULT 'FATO_CONFIRMADO',
    "description" TEXT NOT NULL,
    "legalEffect" TEXT,
    "sourceDocId" TEXT,
    "sourcePage" INTEGER,
    "observation" TEXT,
    "createdByRole" "Role",
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "confidence" "ConfidenceLevel" NOT NULL DEFAULT 'INDETERMINADO',
    "content" JSONB NOT NULL,
    "markdown" TEXT NOT NULL,
    "aiModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Petition" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "type" "PetitionType" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "pendingFields" JSONB,
    "editedByUser" BOOLEAN NOT NULL DEFAULT false,
    "aiModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Petition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalReview" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "reviewerId" TEXT,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDENTE',
    "notes" TEXT,
    "risks" TEXT,
    "divergences" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "LegalReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumptionRecord" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "analysisId" TEXT,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "aiInputTokens" INTEGER,
    "aiOutputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsumptionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "KnowledgeCategory" NOT NULL,
    "description" TEXT,
    "theme" TEXT,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT,
    "storageKey" TEXT,
    "content" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeRevision" (
    "id" TEXT NOT NULL,
    "knowledgeDocumentId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "changeNote" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "kind" "PromptKind" NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT,
    "content" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "requesterId" TEXT NOT NULL,
    "agentId" TEXT,
    "subject" TEXT NOT NULL,
    "category" TEXT,
    "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIA',
    "status" "TicketStatus" NOT NULL DEFAULT 'ABERTO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attachmentKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ConsentType" NOT NULL,
    "version" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ContentBlock" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'pt-BR',
    "data" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" "Role",
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "email" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_ownerId_key" ON "Organization"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthToken_userId_type_idx" ON "AuthToken"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_slug_key" ON "Plan"("slug");

-- CreateIndex
CREATE INDEX "Plan_active_idx" ON "Plan"("active");

-- CreateIndex
CREATE INDEX "Subscription_organizationId_idx" ON "Subscription"("organizationId");

-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

-- CreateIndex
CREATE INDEX "Payment_subscriptionId_idx" ON "Payment"("subscriptionId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "HotmartEvent_externalId_key" ON "HotmartEvent"("externalId");

-- CreateIndex
CREATE INDEX "HotmartEvent_eventType_idx" ON "HotmartEvent"("eventType");

-- CreateIndex
CREATE INDEX "HotmartEvent_status_idx" ON "HotmartEvent"("status");

-- CreateIndex
CREATE INDEX "Analysis_organizationId_idx" ON "Analysis"("organizationId");

-- CreateIndex
CREATE INDEX "Analysis_ownerId_idx" ON "Analysis"("ownerId");

-- CreateIndex
CREATE INDEX "Analysis_status_idx" ON "Analysis"("status");

-- CreateIndex
CREATE INDEX "Document_analysisId_idx" ON "Document"("analysisId");

-- CreateIndex
CREATE INDEX "Document_checksum_idx" ON "Document"("checksum");

-- CreateIndex
CREATE INDEX "DocumentPage_documentId_idx" ON "DocumentPage"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentPage_documentId_pageNumber_key" ON "DocumentPage"("documentId", "pageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TimelineEvent_supersededById_key" ON "TimelineEvent"("supersededById");

-- CreateIndex
CREATE INDEX "TimelineEvent_analysisId_idx" ON "TimelineEvent"("analysisId");

-- CreateIndex
CREATE INDEX "TimelineEvent_type_idx" ON "TimelineEvent"("type");

-- CreateIndex
CREATE INDEX "Report_analysisId_idx" ON "Report"("analysisId");

-- CreateIndex
CREATE UNIQUE INDEX "Report_analysisId_version_key" ON "Report"("analysisId", "version");

-- CreateIndex
CREATE INDEX "Petition_analysisId_idx" ON "Petition"("analysisId");

-- CreateIndex
CREATE UNIQUE INDEX "Petition_analysisId_type_version_key" ON "Petition"("analysisId", "type", "version");

-- CreateIndex
CREATE UNIQUE INDEX "LegalReview_analysisId_key" ON "LegalReview"("analysisId");

-- CreateIndex
CREATE INDEX "LegalReview_reviewerId_idx" ON "LegalReview"("reviewerId");

-- CreateIndex
CREATE INDEX "LegalReview_status_idx" ON "LegalReview"("status");

-- CreateIndex
CREATE INDEX "ConsumptionRecord_subscriptionId_idx" ON "ConsumptionRecord"("subscriptionId");

-- CreateIndex
CREATE INDEX "ConsumptionRecord_kind_idx" ON "ConsumptionRecord"("kind");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_category_idx" ON "KnowledgeDocument"("category");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_active_idx" ON "KnowledgeDocument"("active");

-- CreateIndex
CREATE INDEX "KnowledgeRevision_knowledgeDocumentId_idx" ON "KnowledgeRevision"("knowledgeDocumentId");

-- CreateIndex
CREATE INDEX "PromptVersion_kind_active_idx" ON "PromptVersion"("kind", "active");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_kind_version_key" ON "PromptVersion"("kind", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_number_key" ON "SupportTicket"("number");

-- CreateIndex
CREATE INDEX "SupportTicket_status_idx" ON "SupportTicket"("status");

-- CreateIndex
CREATE INDEX "SupportTicket_requesterId_idx" ON "SupportTicket"("requesterId");

-- CreateIndex
CREATE INDEX "SupportMessage_ticketId_idx" ON "SupportMessage"("ticketId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Consent_userId_type_idx" ON "Consent"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ContentBlock_slug_key" ON "ContentBlock"("slug");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_type_idx" ON "SecurityEvent"("type");

-- CreateIndex
CREATE INDEX "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPage" ADD CONSTRAINT "DocumentPage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "TimelineEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Petition" ADD CONSTRAINT "Petition_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalReview" ADD CONSTRAINT "LegalReview_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalReview" ADD CONSTRAINT "LegalReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumptionRecord" ADD CONSTRAINT "ConsumptionRecord_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumptionRecord" ADD CONSTRAINT "ConsumptionRecord_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeRevision" ADD CONSTRAINT "KnowledgeRevision_knowledgeDocumentId_fkey" FOREIGN KEY ("knowledgeDocumentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
