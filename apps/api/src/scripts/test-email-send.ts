import { OpsService } from '../modules/ops/ops.service';
import { PrismaService } from '../database/prisma.service';
import {
  assertTenantAgentContext,
  optionalEnv,
  requireEnv,
  withDevAppContext,
} from './dev-script-context';

async function run() {
  const tenantId = requireEnv('DEV_TENANT_ID');
  const agentId = requireEnv('DEV_AGENT_ID');
  const toEmail = requireEnv('DEV_TEST_EMAIL_TO');
  const checkoutUrl = optionalEnv('DEV_TEST_CHECKOUT_URL');
  await withDevAppContext(async (app) => {
    const prisma = app.get(PrismaService);
    await assertTenantAgentContext(prisma, tenantId, agentId);
    const ops = app.get(OpsService);
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
