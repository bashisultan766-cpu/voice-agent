-- Autonomous voice runtime: tool permissions + call analytics fields
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "toolPermissions" JSONB;

ALTER TABLE "CallOutcome" ADD COLUMN IF NOT EXISTS "productsRequested" JSONB;
ALTER TABLE "CallOutcome" ADD COLUMN IF NOT EXISTS "conversionOutcome" TEXT;
ALTER TABLE "CallOutcome" ADD COLUMN IF NOT EXISTS "paymentLinkSent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CallOutcome" ADD COLUMN IF NOT EXISTS "orderCompleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CallOutcome" ADD COLUMN IF NOT EXISTS "escalationReason" TEXT;
ALTER TABLE "CallOutcome" ADD COLUMN IF NOT EXISTS "analyticsMeta" JSONB;
