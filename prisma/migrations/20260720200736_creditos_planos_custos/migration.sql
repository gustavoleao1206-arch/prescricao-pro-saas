-- CreateEnum
CREATE TYPE "CreditMovementKind" AS ENUM ('ASSINATURA', 'CONSUMO', 'ESTORNO', 'COMPRA_ADICIONAL', 'EXPIRACAO', 'AJUSTE_ADMIN', 'BONUS');

-- CreateEnum
CREATE TYPE "CreditBucket" AS ENUM ('MENSAL', 'ADICIONAL');

-- AlterTable
ALTER TABLE "Analysis" ADD COLUMN     "creditsCharged" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fileBytes" INTEGER,
ADD COLUMN     "pageCount" INTEGER,
ADD COLUMN     "reprocessCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "benefits" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "contactOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "family" TEXT,
ADD COLUMN     "highlight" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publicPlan" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "creditsReleasedAt" TIMESTAMP(3),
ADD COLUMN     "cycleEndsAt" TIMESTAMP(3),
ADD COLUMN     "graceUntil" TIMESTAMP(3),
ADD COLUMN     "maxUsers" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "nextRenewalAt" TIMESTAMP(3),
ADD COLUMN     "pendingPlanAt" TIMESTAMP(3),
ADD COLUMN     "pendingPlanId" TEXT;

-- CreateTable
CREATE TABLE "CreditPack" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "validityDays" INTEGER NOT NULL DEFAULT 90,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "hotmartOfferCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "kind" "CreditMovementKind" NOT NULL,
    "bucket" "CreditBucket",
    "quantity" INTEGER NOT NULL,
    "balanceBefore" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "analysisId" TEXT,
    "paymentId" TEXT,
    "actorId" TEXT,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsageRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "subscriptionId" TEXT,
    "analysisId" TEXT,
    "userId" TEXT,
    "planSlug" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 1,
    "durationMs" INTEGER,
    "pageCount" INTEGER,
    "fileBytes" INTEGER,
    "creditsCharged" INTEGER NOT NULL DEFAULT 0,
    "reprocess" BOOLEAN NOT NULL DEFAULT false,
    "errored" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditPack_slug_key" ON "CreditPack"("slug");

-- CreateIndex
CREATE INDEX "CreditPack_active_idx" ON "CreditPack"("active");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_idempotencyKey_key" ON "CreditLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditLedger_subscriptionId_createdAt_idx" ON "CreditLedger"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedger_kind_idx" ON "CreditLedger"("kind");

-- CreateIndex
CREATE INDEX "CreditLedger_analysisId_idx" ON "CreditLedger"("analysisId");

-- CreateIndex
CREATE INDEX "CreditLedger_expiresAt_idx" ON "CreditLedger"("expiresAt");

-- CreateIndex
CREATE INDEX "AiUsageRecord_organizationId_idx" ON "AiUsageRecord"("organizationId");

-- CreateIndex
CREATE INDEX "AiUsageRecord_analysisId_idx" ON "AiUsageRecord"("analysisId");

-- CreateIndex
CREATE INDEX "AiUsageRecord_createdAt_idx" ON "AiUsageRecord"("createdAt");

-- CreateIndex
CREATE INDEX "AiUsageRecord_planSlug_idx" ON "AiUsageRecord"("planSlug");

-- CreateIndex
CREATE INDEX "Plan_family_idx" ON "Plan"("family");

-- CreateIndex
CREATE INDEX "Subscription_cycleEndsAt_idx" ON "Subscription"("cycleEndsAt");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pendingPlanId_fkey" FOREIGN KEY ("pendingPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsageRecord" ADD CONSTRAINT "AiUsageRecord_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsageRecord" ADD CONSTRAINT "AiUsageRecord_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;
