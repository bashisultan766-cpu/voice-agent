import Redis from 'ioredis';
import { AgentsService } from '../modules/agents/agents.service';
import { PrismaService } from '../database/prisma.service';
import { assertTenantAgentContext, optionalEnv, requireEnv, withDevAppContext } from './dev-script-context';

type CheckResult = {
  key: string;
  pass: boolean;
  details: string;
  fix?: string;
};

async function checkRedis(redisUrl: string | undefined): Promise<CheckResult> {
  if (!redisUrl?.trim()) {
    return {
      key: 'redis_url_configured',
      pass: false,
      details: 'REDIS_URL is empty.',
      fix: 'Set REDIS_URL to a reachable Redis instance (e.g. redis://localhost:6379).',
    };
  }
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    lazyConnect: true,
  });
  client.on('error', () => {
    // avoid noisy unhandled error events; detailed message is captured by check result
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
  } catch (err) {
    try {
      client.disconnect();
    } catch {
      // no-op
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
  const tenantId = requireEnv('DEV_TENANT_ID');
  const agentId = requireEnv('DEV_AGENT_ID');
  const redisUrl = optionalEnv('REDIS_URL');
  const checks: CheckResult[] = [];

  checks.push(await checkRedis(redisUrl));

  await withDevAppContext(async (app) => {
    const prisma = app.get(PrismaService);
    await assertTenantAgentContext(prisma, tenantId, agentId);

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

    const readiness = await app.get(AgentsService).getAgentReadiness(tenantId, agentId);
    const includeCheck = (key: string) => readiness.checks.find((c) => c.key === key);
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
      if (!row) continue;
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

