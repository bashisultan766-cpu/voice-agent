"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ops_service_1 = require("../modules/ops/ops.service");
const prisma_service_1 = require("../database/prisma.service");
const dev_script_context_1 = require("./dev-script-context");
function parseItems(raw) {
    if (raw?.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed
                    .map((row) => {
                    if (!row || typeof row !== 'object')
                        return null;
                    const r = row;
                    return {
                        variantId: typeof r.variantId === 'string' ? r.variantId : undefined,
                        productId: typeof r.productId === 'string' ? r.productId : undefined,
                        title: typeof r.title === 'string' ? r.title : undefined,
                        quantity: Math.max(1, Number(r.quantity ?? 1) || 1),
                    };
                })
                    .filter((x) => x !== null);
            }
        }
        catch {
        }
    }
    return [];
}
async function run() {
    const tenantId = (0, dev_script_context_1.requireEnv)('DEV_TENANT_ID');
    const agentId = (0, dev_script_context_1.requireEnv)('DEV_AGENT_ID');
    const email = (0, dev_script_context_1.optionalEnv)('DEV_TEST_CUSTOMER_EMAIL') || 'demo.checkout@example.com';
    const mode = (0, dev_script_context_1.optionalEnv)('DEV_TEST_CHECKOUT_MODE') || '';
    const forceNewCheckout = process.env.DEV_TEST_FORCE_NEW_CHECKOUT === 'true';
    const callSessionId = (0, dev_script_context_1.optionalEnv)('DEV_CALL_SESSION_ID');
    await (0, dev_script_context_1.withDevAppContext)(async (app) => {
        const prisma = app.get(prisma_service_1.PrismaService);
        await (0, dev_script_context_1.assertTenantAgentContext)(prisma, tenantId, agentId);
        const ops = app.get(ops_service_1.OpsService);
        let items = parseItems(process.env.DEV_TEST_CHECKOUT_ITEMS);
        if (items.length === 0) {
            const first = await prisma.variantCache.findFirst({
                where: { tenantId },
                orderBy: { updatedAt: 'desc' },
                select: { shopifyVariantId: true, title: true },
            });
            if (!first) {
                throw new Error('No cached variants found. Set DEV_TEST_CHECKOUT_ITEMS JSON or run product sync first.');
            }
            items = [{ variantId: first.shopifyVariantId, title: first.title ?? 'Selected item', quantity: 1 }];
        }
        const args = {
            email,
            items,
            forceNewCheckout,
        };
        if (mode)
            args.mode = mode;
        const result = await ops.simulateToolCall(tenantId, agentId, {
            callSessionId,
            toolName: 'createCheckoutLink',
            args,
        });
        console.log(JSON.stringify(result, null, 2));
    });
}
run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
//# sourceMappingURL=test-checkout-link.js.map