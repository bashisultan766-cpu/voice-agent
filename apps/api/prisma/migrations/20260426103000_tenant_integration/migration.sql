-- CreateTable
CREATE TABLE "TenantIntegration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopifyShopDomain" TEXT,
    "shopifyAdminTokenEnc" TEXT,
    "shopifyLastTestOk" BOOLEAN,
    "shopifyLastTestAt" TIMESTAMP(3),
    "twilioAccountSid" TEXT,
    "twilioAuthTokenEnc" TEXT,
    "twilioPhoneNumber" TEXT,
    "twilioPhoneSid" TEXT,
    "twilioLastTestOk" BOOLEAN,
    "twilioLastTestAt" TIMESTAMP(3),
    "openaiApiKeyEnc" TEXT,
    "openaiLastTestOk" BOOLEAN,
    "openaiLastTestAt" TIMESTAMP(3),
    "resendApiKeyEnc" TEXT,
    "resendFromEmail" TEXT,
    "emailLastTestOk" BOOLEAN,
    "emailLastTestAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantIntegration_tenantId_key" ON "TenantIntegration"("tenantId");

-- CreateIndex
CREATE INDEX "TenantIntegration_tenantId_idx" ON "TenantIntegration"("tenantId");

-- AddForeignKey
ALTER TABLE "TenantIntegration" ADD CONSTRAINT "TenantIntegration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
