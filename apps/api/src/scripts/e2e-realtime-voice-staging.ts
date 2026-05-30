/**
 * Staging E2E for realtime voice: synthetic call through full checkout + webhook verify.
 *
 * Usage:
 *   pnpm e2e:realtime-voice-staging
 *   pnpm e2e:realtime-voice-staging --report-only
 *
 * Required env:
 *   DEV_TENANT_ID, DEV_AGENT_ID, DATABASE_URL, REDIS_URL, DEV_TEST_CUSTOMER_EMAIL
 * Optional:
 *   E2E_PRODUCT_QUERY (default: from E2E_PRODUCT_QUERY or "Atomic Habits")
 *   E2E_SKIP_WEBHOOK=true — skip simulated payment webhook
 *   E2E_SHOP_DOMAIN — override Shopify shop domain for webhook simulation
 */
import 'reflect-metadata';
import { withDevAppContext, requireEnv, optionalEnv, assertTenantAgentContext } from './dev-script-context';
import { PrismaService } from '../database/prisma.service';
import { runSyntheticStagingCall } from '../modules/realtime-voice/e2e/synthetic-call-runner';
import {
  printProductionReadinessReport,
  runStagingPreflight,
} from './e2e-staging-preflight.util';

function shopDomainFromUrl(url: string | null | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    return host.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0]?.replace(/^www\./, '');
  }
}

async function main(): Promise<void> {
  const reportOnly = process.argv.includes('--report-only');
  const preflight = await runStagingPreflight(process.env);

  if (reportOnly) {
    printProductionReadinessReport({
      pass: preflight.ok,
      preflight,
    });
    process.exit(preflight.ok ? 0 : 1);
  }

  const tenantId = requireEnv('DEV_TENANT_ID');
  const agentId = requireEnv('DEV_AGENT_ID');
  const customerEmail = requireEnv('DEV_TEST_CUSTOMER_EMAIL');
  const productQuery = optionalEnv('E2E_PRODUCT_QUERY') || optionalEnv('DEV_FLOW_QUERY') || 'Atomic Habits';
  const skipWebhook = process.env.E2E_SKIP_WEBHOOK === 'true';

  let e2eResult: Awaited<ReturnType<typeof runSyntheticStagingCall>> | undefined;

  await withDevAppContext(async (app) => {
    const prisma = app.get(PrismaService);
    await assertTenantAgentContext(prisma, tenantId, agentId);

    const agent = await prisma.agent.findFirst({
      where: { id: agentId, tenantId },
      select: { shopifyStoreUrl: true },
    });
    const shopDomain =
      optionalEnv('E2E_SHOP_DOMAIN') ?? shopDomainFromUrl(agent?.shopifyStoreUrl ?? undefined);

    e2eResult = await runSyntheticStagingCall(app, {
      tenantId,
      agentId,
      productQuery,
      customerEmail,
      simulatePaymentWebhook: !skipWebhook,
      shopDomain,
    });
  });

  if (!e2eResult) {
    console.error('E2E runner did not produce a result.');
    process.exit(1);
  }

  const overallPass = preflight.ok && e2eResult.pass;

  printProductionReadinessReport({
    pass: overallPass,
    preflight,
    e2e: {
      pass: e2eResult.pass,
      traceId: e2eResult.traceId,
      latency: e2eResult.latency,
    },
  });

  console.log(JSON.stringify({ report: e2eResult }, null, 2));

  process.exit(overallPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
