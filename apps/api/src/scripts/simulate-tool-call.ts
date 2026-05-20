import { OpsService } from '../modules/ops/ops.service';
import { PrismaService } from '../database/prisma.service';
import {
  assertTenantAgentContext,
  optionalEnv,
  requireEnv,
  withDevAppContext,
} from './dev-script-context';

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // no-op
  }
  return {};
}

async function run() {
  const tenantId = requireEnv('DEV_TENANT_ID');
  const agentId = requireEnv('DEV_AGENT_ID');
  const toolName = optionalEnv('DEV_TOOL_NAME') || 'searchProducts';
  const callSessionId = optionalEnv('DEV_CALL_SESSION_ID');
  const args = parseArgs(process.env.DEV_TOOL_ARGS);

  await withDevAppContext(async (app) => {
    const prisma = app.get(PrismaService);
    await assertTenantAgentContext(prisma, tenantId, agentId);
    const ops = app.get(OpsService);
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
