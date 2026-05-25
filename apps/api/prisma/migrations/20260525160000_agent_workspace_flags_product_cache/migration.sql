-- Per-agent workspace opt-in flags (default false) + agent-scoped product cache.
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "useWorkspaceOpenai" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "useWorkspaceElevenlabs" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "useWorkspaceTwilio" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AgentConfig" ALTER COLUMN "useWorkspaceEmail" SET DEFAULT false;

-- Reset catalog cache so rows are not shared across agents (re-sync per agent after deploy).
DELETE FROM "VariantCache";
DELETE FROM "ProductCache";

ALTER TABLE "ProductCache" ADD COLUMN IF NOT EXISTS "agentId" TEXT NOT NULL;

ALTER TABLE "ProductCache" DROP CONSTRAINT IF EXISTS "ProductCache_tenantId_shopifyProductId_key";
DROP INDEX IF EXISTS "ProductCache_tenantId_shopifyProductId_key";

CREATE INDEX IF NOT EXISTS "ProductCache_agentId_idx" ON "ProductCache"("agentId");
CREATE INDEX IF NOT EXISTS "ProductCache_tenantId_agentId_shopDomain_idx" ON "ProductCache"("tenantId", "agentId", "shopDomain");

ALTER TABLE "ProductCache" ADD CONSTRAINT "ProductCache_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "ProductCache_tenantId_agentId_shopifyProductId_key"
  ON "ProductCache"("tenantId", "agentId", "shopifyProductId");
