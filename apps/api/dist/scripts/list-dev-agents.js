"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const dev_script_context_1 = require("./dev-script-context");
const prisma_service_1 = require("../database/prisma.service");
function safe(s) {
    return (s ?? '').trim();
}
async function main() {
    await (0, dev_script_context_1.withDevAppContext)(async (app) => {
        const prisma = app.get(prisma_service_1.PrismaService);
        const agents = await prisma.agent.findMany({
            where: { deletedAt: null },
            orderBy: [{ updatedAt: 'desc' }],
            take: 200,
            select: {
                id: true,
                tenantId: true,
                name: true,
                status: true,
                storeId: true,
                shopifyStoreUrl: true,
                store: { select: { name: true, shopifyConnection: { select: { shopDomain: true } } } },
                tenant: { select: { name: true } },
            },
        });
        const rows = agents.map((a) => ({
            tenantId: a.tenantId,
            tenantName: a.tenant?.name ?? 'Tenant',
            storeName: a.store?.name ?? null,
            agentId: a.id,
            agentName: a.name,
            agentStatus: String(a.status),
            shopDomain: a.store?.shopifyConnection?.shopDomain ?? null,
            shopUrl: a.shopifyStoreUrl ?? null,
        }));
        if (rows.length === 0) {
            console.log(JSON.stringify({
                ok: false,
                message: 'No agents found in this database.',
                hint: 'Run your DB migrations/seed and create at least one agent.',
            }, null, 2));
            return;
        }
        const out = rows.map((r) => ({
            tenantId: r.tenantId,
            tenantName: r.tenantName,
            storeName: r.storeName,
            agentId: r.agentId,
            agentName: r.agentName,
            agentStatus: r.agentStatus,
            shopDomain: safe(r.shopDomain) || null,
            shopUrl: safe(r.shopUrl) || null,
            runVoiceSim_oneLiner: `DEV_TENANT_ID=${r.tenantId} DEV_AGENT_ID=${r.agentId} pnpm --filter api test:voice-sim`,
            runVoiceSim_powershell: [
                `$env:DEV_TENANT_ID="${r.tenantId}"`,
                `$env:DEV_AGENT_ID="${r.agentId}"`,
                `pnpm --filter api test:voice-sim`,
            ].join('\n'),
        }));
        console.log(JSON.stringify({
            ok: true,
            message: 'Copy an agentId + tenantId from below, then run voice QA sim.',
            examples: {
                bash_or_cmd_one_liner: 'DEV_TENANT_ID=xxx DEV_AGENT_ID=yyy pnpm --filter api test:voice-sim',
                powershell: ['$env:DEV_TENANT_ID="xxx"', '$env:DEV_AGENT_ID="yyy"', 'pnpm --filter api test:voice-sim'].join('\n'),
            },
            agents: out,
        }, null, 2));
    });
}
main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
//# sourceMappingURL=list-dev-agents.js.map