-- AlterEnum
ALTER TYPE "ConsentType" ADD VALUE 'CONDICOES_ASSINATURA';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "method" TEXT;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "amountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "canceledReason" TEXT,
ADD COLUMN     "reactivatedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedAt" TIMESTAMP(3);
