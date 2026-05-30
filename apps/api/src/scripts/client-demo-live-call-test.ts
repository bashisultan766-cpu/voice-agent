/**
 * Live client-demo call test: real Twilio outbound call + real provider validation + commerce trace.
 *
 * Usage:
 *   pnpm client-demo:live-call-test
 *
 * Required env:
 *   Same as client-demo:readiness, plus for live call:
 *   CLIENT_DEMO_CALL_FROM — Twilio-owned caller (often same as agent number)
 *   CLIENT_DEMO_CALL_TO   — agent inbound number (E.164)
 *
 * Optional:
 *   CLIENT_DEMO_SKIP_SYNTHETIC=true — voice/call only, no orchestrator commerce path
 *   CLIENT_DEMO_SKIP_READINESS=true — skip full readiness (faster, not recommended)
 */
import 'reflect-metadata';
import {
  assertTenantAgentContext,
  optionalEnv,
  requireEnv,
  withDevAppContext,
} from './dev-script-context';
import { PrismaService } from '../database/prisma.service';
import { runClientDemoLiveCallTest } from './client-demo/client-demo-live-call.runner';
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

  let report: Awaited<ReturnType<typeof runClientDemoLiveCallTest>> | undefined;

  await withDevAppContext(async (app) => {
    const prisma = app.get(PrismaService);
    await assertTenantAgentContext(prisma, tenantId, agentId);
    report = await runClientDemoLiveCallTest(app, {
      tenantId,
      agentId,
      productQuery,
      isbnQuery,
      customerEmail,
      callFrom: optionalEnv('CLIENT_DEMO_CALL_FROM'),
      callTo: optionalEnv('CLIENT_DEMO_CALL_TO'),
      runSyntheticCommerce: process.env.CLIENT_DEMO_SKIP_SYNTHETIC !== 'true',
      skipReadiness: process.env.CLIENT_DEMO_SKIP_READINESS === 'true',
    });
  });

  if (!report) {
    console.error('Live call test did not produce a report.');
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
