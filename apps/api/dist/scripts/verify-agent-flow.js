"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const core_1 = require("@nestjs/core");
const app_module_1 = require("../app.module");
const agents_service_1 = require("../modules/agents/agents.service");
const prisma_service_1 = require("../database/prisma.service");
const session_context_service_1 = require("../modules/calls/runtime/session-context.service");
async function main() {
    const tenantId = process.env.VERIFY_TENANT_ID?.trim();
    if (!tenantId) {
        throw new Error('VERIFY_TENANT_ID is required.');
    }
    const stamp = Date.now().toString().slice(-6);
    const agentName = `Frontend Verify ${stamp}`;
    const app = await core_1.NestFactory.createApplicationContext(app_module_1.AppModule, { logger: false });
    try {
        const agents = app.get(agents_service_1.AgentsService);
        const prisma = app.get(prisma_service_1.PrismaService);
        const sessionCtx = app.get(session_context_service_1.SessionContextService);
        const created = await agents.create(tenantId, {
            agentName,
            storeName: 'Integration Test Store',
            agentStatus: 'draft',
            language: 'en',
            timezone: 'UTC',
            checkoutMode: 'cart',
        });
        const dbAgent = await prisma.agent.findFirst({
            where: { id: created.id, tenantId, deletedAt: null },
            include: { agentConfig: true },
        });
        const call = await prisma.callSession.create({
            data: {
                tenantId,
                agentId: created.id,
                storeId: created.storeId ?? null,
                status: 'INITIATED',
                direction: 'inbound',
                startedAt: new Date(),
            },
        });
        const loaded = await sessionCtx.load(call.id);
        console.log(JSON.stringify({
            createdAgentId: created.id,
            dbSaved: Boolean(dbAgent),
            hasAgentConfig: Boolean(dbAgent?.agentConfig),
            sessionContextLoaded: Boolean(loaded),
            loadedCheckoutMode: loaded?.agent?.config?.checkoutMode ?? null,
        }, null, 2));
    }
    finally {
        await app.close();
    }
}
main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
});
//# sourceMappingURL=verify-agent-flow.js.map