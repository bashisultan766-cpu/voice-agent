-- Additive migration to preserve OpenAI key prefix hint for masking.
ALTER TABLE "TenantIntegration"
ADD COLUMN IF NOT EXISTS "openaiKeyPrefix" TEXT;
