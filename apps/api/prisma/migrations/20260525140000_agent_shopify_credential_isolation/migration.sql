-- Per-agent Shopify isolation: workspace Shopify is opt-in only.
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "useWorkspaceShopify" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "shopifyApiVersion" TEXT;
