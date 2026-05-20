"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ops_service_1 = require("../modules/ops/ops.service");
const prisma_service_1 = require("../database/prisma.service");
const dev_script_context_1 = require("./dev-script-context");
async function run() {
    const tenantId = (0, dev_script_context_1.requireEnv)('DEV_TENANT_ID');
    const agentId = (0, dev_script_context_1.requireEnv)('DEV_AGENT_ID');
    const toEmail = (0, dev_script_context_1.requireEnv)('DEV_TEST_EMAIL_TO');
    const checkoutUrl = (0, dev_script_context_1.optionalEnv)('DEV_TEST_CHECKOUT_URL');
    await (0, dev_script_context_1.withDevAppContext)(async (app) => {
        const prisma = app.get(prisma_service_1.PrismaService);
        await (0, dev_script_context_1.assertTenantAgentContext)(prisma, tenantId, agentId);
        const ops = app.get(ops_service_1.OpsService);
        const result = await ops.sendDevelopmentTestEmail(tenantId, agentId, {
            toEmail,
            checkoutUrl: checkoutUrl || undefined,
        });
        console.log(JSON.stringify(result, null, 2));
    });
}
run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
//# sourceMappingURL=test-email-send.js.map