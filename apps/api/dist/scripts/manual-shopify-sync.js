"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const product_sync_1 = require("../modules/integrations/shopify/product-sync");
const prisma_service_1 = require("../database/prisma.service");
const dev_script_context_1 = require("./dev-script-context");
async function run() {
    const tenantId = (0, dev_script_context_1.requireEnv)('DEV_TENANT_ID');
    const agentId = (0, dev_script_context_1.requireEnv)('DEV_AGENT_ID');
    await (0, dev_script_context_1.withDevAppContext)(async (app) => {
        const prisma = app.get(prisma_service_1.PrismaService);
        await (0, dev_script_context_1.assertTenantAgentContext)(prisma, tenantId, agentId);
        const startedAt = Date.now();
        const sync = app.get(product_sync_1.ShopifyProductSyncService);
        const result = await sync.syncProducts(tenantId, agentId);
        console.log(JSON.stringify({
            ok: true,
            tenantId,
            agentId,
            elapsedMs: Date.now() - startedAt,
            ...result,
        }));
    });
}
run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
//# sourceMappingURL=manual-shopify-sync.js.map