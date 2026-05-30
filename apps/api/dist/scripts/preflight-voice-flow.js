"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ioredis_1 = require("ioredis");
const redis_client_util_1 = require("../common/redis-client.util");
const agents_service_1 = require("../modules/agents/agents.service");
const prisma_service_1 = require("../database/prisma.service");
const dev_script_context_1 = require("./dev-script-context");
async function checkRedis(redisUrl) {
    const normalized = (0, redis_client_util_1.normalizeRedisUrl)(redisUrl);
    if (!normalized) {
        return {
            key: 'redis_url_configured',
            pass: false,
            details: 'REDIS_URL is empty.',
            fix: 'Set REDIS_URL to a reachable Redis instance (e.g. redis://127.0.0.1:6379).',
        };
    }
    const client = new ioredis_1.default(normalized, {
        ...redis_client_util_1.REDIS_CLIENT_OPTIONS,
        maxRetriesPerRequest: 1,
        connectTimeout: 1500,
    });
    client.on('error', () => {
    });
    try {
        const pong = await client.ping();
        client.disconnect();
        return {
            key: 'redis_reachable',
            pass: pong === 'PONG',
            details: `PING ${pong}`,
            fix: pong === 'PONG' ? undefined : 'Ensure Redis is running and reachable from API.',
        };
    }
    catch (err) {
        try {
            client.disconnect();
        }
        catch {
        }
        return {
            key: 'redis_reachable',
            pass: false,
            details: err instanceof Error ? err.message : 'Redis connection failed',
            fix: 'Start Redis or update REDIS_URL to a reachable instance.',
        };
    }
}
async function run() {
    const tenantId = (0, dev_script_context_1.requireEnv)('DEV_TENANT_ID');
    const agentId = (0, dev_script_context_1.requireEnv)('DEV_AGENT_ID');
    const redisUrl = (0, dev_script_context_1.optionalEnv)('REDIS_URL');
    const checks = [];
    checks.push(await checkRedis(redisUrl));
    await (0, dev_script_context_1.withDevAppContext)(async (app) => {
        const prisma = app.get(prisma_service_1.PrismaService);
        await (0, dev_script_context_1.assertTenantAgentContext)(prisma, tenantId, agentId);
        const agent = await prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: {
                id: true,
                name: true,
                twilioPhoneNumber: true,
                shopifyStoreUrl: true,
                shopifyStoreNumber: true,
            },
        });
        if (!agent) {
            checks.push({
                key: 'dev_agent_exists',
                pass: false,
                details: 'DEV_TENANT_ID / DEV_AGENT_ID do not map to an active agent.',
            });
            return;
        }
        checks.push({
            key: 'dev_agent_exists',
            pass: true,
            details: `Agent "${agent.name}" (${agent.id}) found.`,
        });
        checks.push({
            key: 'shopify_mapping_present',
            pass: Boolean(agent.shopifyStoreUrl?.trim() || agent.shopifyStoreNumber?.trim()),
            details: agent.shopifyStoreUrl?.trim()
                ? `shopifyStoreUrl=${agent.shopifyStoreUrl}`
                : agent.shopifyStoreNumber?.trim()
                    ? `shopifyStoreNumber=${agent.shopifyStoreNumber}`
                    : 'No Shopify mapping set.',
            fix: 'Set shopifyStoreUrl or shopifyStoreNumber on the agent before simulation.',
        });
        checks.push({
            key: 'twilio_number_present',
            pass: Boolean(agent.twilioPhoneNumber?.trim()),
            details: agent.twilioPhoneNumber?.trim() ? `twilioPhoneNumber=${agent.twilioPhoneNumber}` : 'No Twilio number on agent.',
            fix: 'Set twilioPhoneNumber on the agent and map webhook routes.',
        });
        const readiness = await app.get(agents_service_1.AgentsService).getAgentReadiness(tenantId, agentId);
        const includeCheck = (key) => readiness.checks.find((c) => c.key === key);
        const readinessKeys = [
            'twilio_webhook_verified',
            'shopify_connected',
            'catalog_ready',
            'openai_connected',
            'email_connected',
            'system_prompt_configured',
        ];
        for (const key of readinessKeys) {
            const row = includeCheck(key);
            if (!row)
                continue;
            checks.push({
                key: row.key,
                pass: row.pass,
                details: row.label,
                fix: row.pass ? undefined : row.fixAction,
            });
        }
    });
    const passed = checks.filter((c) => c.pass).length;
    const result = {
        ok: checks.every((c) => c.pass),
        summary: `${passed}/${checks.length} checks passing`,
        checks,
    };
    console.log(JSON.stringify(result, null, 2));
}
run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
//# sourceMappingURL=preflight-voice-flow.js.map