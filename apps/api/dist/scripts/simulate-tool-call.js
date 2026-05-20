"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ops_service_1 = require("../modules/ops/ops.service");
const prisma_service_1 = require("../database/prisma.service");
const dev_script_context_1 = require("./dev-script-context");
function parseArgs(raw) {
    if (!raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
    }
    return {};
}
async function run() {
    const tenantId = (0, dev_script_context_1.requireEnv)('DEV_TENANT_ID');
    const agentId = (0, dev_script_context_1.requireEnv)('DEV_AGENT_ID');
    const toolName = (0, dev_script_context_1.optionalEnv)('DEV_TOOL_NAME') || 'searchProducts';
    const callSessionId = (0, dev_script_context_1.optionalEnv)('DEV_CALL_SESSION_ID');
    const args = parseArgs(process.env.DEV_TOOL_ARGS);
    await (0, dev_script_context_1.withDevAppContext)(async (app) => {
        const prisma = app.get(prisma_service_1.PrismaService);
        await (0, dev_script_context_1.assertTenantAgentContext)(prisma, tenantId, agentId);
        const ops = app.get(ops_service_1.OpsService);
        const result = await ops.simulateToolCall(tenantId, agentId, {
            toolName,
            args,
            callSessionId,
        });
        console.log(JSON.stringify(result, null, 2));
    });
}
run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
//# sourceMappingURL=simulate-tool-call.js.map