import { OpsService } from '../modules/ops/ops.service';
import { PrismaService } from '../database/prisma.service';
import {
  assertTenantAgentContext,
  optionalEnv,
  requireEnv,
  withDevAppContext,
} from './dev-script-context';

function parseItems(raw: string | undefined): Array<{ variantId?: string; productId?: string; title?: string; quantity: number }> {
  if (raw?.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((row) => {
            if (!row || typeof row !== 'object') return null;
            const r = row as Record<string, unknown>;
            return {
              variantId: typeof r.variantId === 'string' ? r.variantId : undefined,
              productId: typeof r.productId === 'string' ? r.productId : undefined,
              title: typeof r.title === 'string' ? r.title : undefined,
              quantity: Math.max(1, Number(r.quantity ?? 1) || 1),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
      }
    } catch {
      // Ignore and fall back to defaults.
    }
  }
  return [];
}

async function run() {
  const tenantId = requireEnv('DEV_TENANT_ID');
  const agentId = requireEnv('DEV_AGENT_ID');
  const email = optionalEnv('DEV_TEST_CUSTOMER_EMAIL') || 'demo.checkout@example.com';
  const mode = optionalEnv('DEV_TEST_CHECKOUT_MODE') || '';
  const forceNewCheckout = process.env.DEV_TEST_FORCE_NEW_CHECKOUT === 'true';
  const callSessionId = optionalEnv('DEV_CALL_SESSION_ID');

  await withDevAppContext(async (app) => {
    const prisma = app.get(PrismaService);
    await assertTenantAgentContext(prisma, tenantId, agentId);
    const ops = app.get(OpsService);
    let items = parseItems(process.env.DEV_TEST_CHECKOUT_ITEMS);
    if (items.length === 0) {
      const first = await prisma.variantCache.findFirst({
        where: { tenantId },
        orderBy: { updatedAt: 'desc' },
        select: { shopifyVariantId: true, title: true },
      });
      if (!first) {
        throw new Error(
          'No cached variants found. Set DEV_TEST_CHECKOUT_ITEMS JSON or run product sync first.',
        );
      }
      items = [{ variantId: first.shopifyVariantId, title: first.title ?? 'Selected item', quantity: 1 }];
    }

    const args: Record<string, unknown> = {
      email,
      items,
      forceNewCheckout,
    };
    if (mode) args.mode = mode;

    const result = await ops.simulateToolCall(tenantId, agentId, {
      callSessionId,
      toolName: 'createCheckoutLink',
      args,
    });
    console.log(JSON.stringify(result, null, 2));
  });
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
