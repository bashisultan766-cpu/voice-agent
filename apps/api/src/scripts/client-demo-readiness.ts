/**
 * Real client-demo readiness: providers, Shopify catalog/checkout, Resend email, voice probes.
 *
 * Usage:
 *   pnpm client-demo:readiness
 *
 * Required env:
 *   DEV_TENANT_ID, DEV_AGENT_ID, DATABASE_URL, DEV_TEST_CUSTOMER_EMAIL,
 *   PUBLIC_WEBHOOK_BASE_URL, CLIENT_DEMO_EMAIL_ALLOWLIST (staging)
 *
 * Optional:
 *   CLIENT_DEMO_PRODUCT_QUERY — title search (default: DEV_FLOW_QUERY or "Atomic Habits")
 *   CLIENT_DEMO_PRODUCT_ISBN — ISBN search validation
 *   CLIENT_DEMO_SKIP_EMAIL=true — skip real Resend send
 *   CLIENT_DEMO_STAGING_MODE=true — enforce staging safety (default when NODE_ENV !== production)
 */
import 'reflect-metadata';
import {
  assertTenantAgentContext,
  optionalEnv,
  requireEnv,
  withDevAppContext,
} from './dev-script-context';
import { PrismaService } from '../database/prisma.service';
import { runClientDemoReadiness } from './client-demo/client-demo-readiness.runner';
import {
  printClientDemoReport,
  writeClientDemoReportFile,
} from './client-demo/client-demo-report.util';

async function main(): Promise<void> {
  const tenantId = requireEnv('DEV_TENANT_ID');
  const agentId = requireEnv('DEV_AGENT_ID');
  const customerEmail = requireEnv('DEV_TEST_CUSTOMER_EMAIL').toLowerCase();
  const productQuery =
    optionalEnv('CLIENT_DEMO_PRODUCT_QUERY') ||
    optionalEnv('E2E_PRODUCT_QUERY') ||
    optionalEnv('DEV_FLOW_QUERY') ||
    'Atomic Habits';
  const isbnQuery = optionalEnv('CLIENT_DEMO_PRODUCT_ISBN');
  const skipEmailSend = process.env.CLIENT_DEMO_SKIP_EMAIL === 'true';

  let report: Awaited<ReturnType<typeof runClientDemoReadiness>> | undefined;

  await withDevAppContext(async (app) => {
    const prisma = app.get(PrismaService);
    await assertTenantAgentContext(prisma, tenantId, agentId);
    report = await runClientDemoReadiness(app, {
      tenantId,
      agentId,
      productQuery,
      isbnQuery,
      customerEmail,
      skipEmailSend,
    });
  });

  if (!report) {
    console.error('Client demo readiness did not produce a report.');
    process.exit(1);
  }

  printClientDemoReport(report);
  writeClientDemoReportFile(report);
  process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
