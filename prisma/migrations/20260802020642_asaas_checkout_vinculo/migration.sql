-- CreateTable
CREATE TABLE "AsaasCheckout" (
    "id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AsaasCheckout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AsaasCheckout_userId_idx" ON "AsaasCheckout"("userId");

-- CreateIndex
CREATE INDEX "AsaasCheckout_createdAt_idx" ON "AsaasCheckout"("createdAt");

-- AddForeignKey
ALTER TABLE "AsaasCheckout" ADD CONSTRAINT "AsaasCheckout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
