-- CreateEnum
CREATE TYPE "PaymentLifecycleStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "PaymentRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "callSessionId" TEXT,
    "checkoutLinkId" TEXT NOT NULL,
    "customerEmail" TEXT,
    "shopifyOrderId" TEXT,
    "shopifyOrderName" TEXT,
    "paymentStatus" "PaymentLifecycleStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "webhookEventKey" TEXT,
    "lastWebhookTopic" TEXT,
    "rawWebhookPayloadJson" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentRecord_tenantId_idx" ON "PaymentRecord"("tenantId");

-- CreateIndex
CREATE INDEX "PaymentRecord_agentId_idx" ON "PaymentRecord"("agentId");

-- CreateIndex
CREATE INDEX "PaymentRecord_callSessionId_idx" ON "PaymentRecord"("callSessionId");

-- CreateIndex
CREATE INDEX "PaymentRecord_checkoutLinkId_idx" ON "PaymentRecord"("checkoutLinkId");

-- CreateIndex
CREATE INDEX "PaymentRecord_paymentStatus_idx" ON "PaymentRecord"("paymentStatus");

-- CreateIndex
CREATE INDEX "PaymentRecord_customerEmail_idx" ON "PaymentRecord"("customerEmail");

-- CreateIndex
CREATE INDEX "PaymentRecord_shopifyOrderId_idx" ON "PaymentRecord"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "PaymentRecord_createdAt_idx" ON "PaymentRecord"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecord_tenantId_webhookEventKey_key" ON "PaymentRecord"("tenantId", "webhookEventKey");

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_callSessionId_fkey" FOREIGN KEY ("callSessionId") REFERENCES "CallSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_checkoutLinkId_fkey" FOREIGN KEY ("checkoutLinkId") REFERENCES "CheckoutLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
