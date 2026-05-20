-- Additive migration for workspace-level ElevenLabs integration fields.
ALTER TABLE "TenantIntegration"
ADD COLUMN IF NOT EXISTS "elevenlabsApiKeyEnc" TEXT,
ADD COLUMN IF NOT EXISTS "elevenlabsKeyLast4" TEXT,
ADD COLUMN IF NOT EXISTS "elevenlabsDefaultVoiceId" TEXT,
ADD COLUMN IF NOT EXISTS "elevenlabsDefaultModel" TEXT,
ADD COLUMN IF NOT EXISTS "elevenlabsLastTestOk" BOOLEAN,
ADD COLUMN IF NOT EXISTS "elevenlabsLastTestAt" TIMESTAMP(3);
