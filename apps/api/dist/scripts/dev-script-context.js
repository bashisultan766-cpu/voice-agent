"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireEnv = requireEnv;
exports.optionalEnv = optionalEnv;
exports.assertTenantAgentContext = assertTenantAgentContext;
exports.withDevAppContext = withDevAppContext;
require("reflect-metadata");
const core_1 = require("@nestjs/core");
const app_module_1 = require("../app.module");
function requireEnv(name) {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is required.`);
    }
    return value;
}
function optionalEnv(name) {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
}
async function assertTenantAgentContext(prisma, tenantId, agentId) {
    const agent = await prisma.agent.findFirst({
        where: { id: agentId, tenantId, deletedAt: null },
        select: { id: true },
    });
    if (!agent) {
        throw new Error('DEV_TENANT_ID / DEV_AGENT_ID do not map to a live agent in this database.');
    }
}
async function withDevAppContext(fn) {
    const app = await core_1.NestFactory.createApplicationContext(app_module_1.AppModule, {
        logger: ['error', 'warn', 'log'],
    });
    try {
        return await fn(app);
    }
    finally {
        await app.close();
    }
}
//# sourceMappingURL=dev-script-context.js.map