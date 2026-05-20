import { ShopifyProductSyncService } from '../modules/integrations/shopify/product-sync';
import { PrismaService } from '../database/prisma.service';
import {
  assertTenantAgentContext,
  requireEnv,
  withDevAppContext,
} from './dev-script-context';

async function run() {
  const tenantId = requireEnv('DEV_TENANT_ID');
  const agentId = requireEnv('DEV_AGENT_ID');

  await withDevAppContext(async (app) => {
    const prisma = app.get(PrismaService);
    await assertTenantAgentContext(prisma, tenantId, agentId);
    const startedAt = Date.now();
    const sync = app.get(ShopifyProductSyncService);
    const result = await sync.syncProducts(tenantId, agentId);
    console.log(
      JSON.stringify({
        ok: true,
        tenantId,
        agentId,
        elapsedMs: Date.now() - startedAt,
        ...result,
      }),
    );
  });
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
