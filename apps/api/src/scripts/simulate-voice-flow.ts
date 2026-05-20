import { OpsService } from '../modules/ops/ops.service';
import { PrismaService } from '../database/prisma.service';
import {
  assertTenantAgentContext,
  optionalEnv,
  requireEnv,
  withDevAppContext,
} from './dev-script-context';

type ToolResultEnvelope = {
  callSessionId: string;
  toolName: string;
  result: {
    ok: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  };
};

function readDataObject(result: ToolResultEnvelope['result']): Record<string, unknown> {
  return result.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? (result.data as Record<string, unknown>)
    : {};
}

async function run() {
  const tenantId = requireEnv('DEV_TENANT_ID');
  const agentId = requireEnv('DEV_AGENT_ID');
  const productQuery = optionalEnv('DEV_FLOW_QUERY') || 'demo';
  const customerEmail = optionalEnv('DEV_TEST_CUSTOMER_EMAIL') || 'demo.customer@example.com';
  const sendEmail = process.env.DEV_FLOW_SEND_EMAIL !== 'false';
  const callSessionId = optionalEnv('DEV_CALL_SESSION_ID');
  const checkoutMode = optionalEnv('DEV_TEST_CHECKOUT_MODE');

  await withDevAppContext(async (app) => {
    const prisma = app.get(PrismaService);
    await assertTenantAgentContext(prisma, tenantId, agentId);
    const ops = app.get(OpsService);
    const steps: Array<{ step: string; output: unknown }> = [];

    const search = (await ops.simulateToolCall(tenantId, agentId, {
      callSessionId,
      toolName: 'searchProducts',
      args: { query: productQuery, limit: 5 },
    })) as ToolResultEnvelope;
    steps.push({ step: 'searchProducts', output: search });
    if (!search.result.ok) {
      console.log(JSON.stringify({ ok: false, reason: 'search failed', steps }, null, 2));
      return;
    }

    const searchData = readDataObject(search.result);
    const results = Array.isArray(searchData.results) ? (searchData.results as Array<Record<string, unknown>>) : [];
    const first = results[0];
    if (!first) {
      console.log(JSON.stringify({ ok: false, reason: 'no products found', steps }, null, 2));
      return;
    }
    const productId = typeof first.id === 'string' ? first.id : '';
    const variants = Array.isArray(first.variants) ? (first.variants as Array<Record<string, unknown>>) : [];
    const firstVariantId = typeof variants[0]?.id === 'string' ? (variants[0].id as string) : '';

    const details = (await ops.simulateToolCall(tenantId, agentId, {
      callSessionId: search.callSessionId,
      toolName: 'getProductDetails',
      args: { productId, variantId: firstVariantId || undefined },
    })) as ToolResultEnvelope;
    steps.push({ step: 'getProductDetails', output: details });
    if (!details.result.ok) {
      console.log(JSON.stringify({ ok: false, reason: 'details failed', steps }, null, 2));
      return;
    }

    const checkoutArgs: Record<string, unknown> = {
      email: customerEmail,
      items: [{ variantId: firstVariantId || productId, quantity: 1 }],
      forceNewCheckout: false,
    };
    if (checkoutMode) checkoutArgs.mode = checkoutMode;

    const checkout = (await ops.simulateToolCall(tenantId, agentId, {
      callSessionId: search.callSessionId,
      toolName: 'createCheckoutLink',
      args: checkoutArgs,
    })) as ToolResultEnvelope;
    steps.push({ step: 'createCheckoutLink', output: checkout });
    if (!checkout.result.ok || !sendEmail) {
      console.log(JSON.stringify({ ok: checkout.result.ok, steps }, null, 2));
      return;
    }

    const checkoutData = readDataObject(checkout.result);
    const checkoutLinkId =
      typeof checkoutData.checkoutLinkId === 'string' ? checkoutData.checkoutLinkId : '';
    if (!checkoutLinkId) {
      console.log(JSON.stringify({ ok: false, reason: 'checkoutLinkId missing', steps }, null, 2));
      return;
    }

    const email = (await ops.simulateToolCall(tenantId, agentId, {
      callSessionId: search.callSessionId,
      toolName: 'sendPaymentEmail',
      args: { email: customerEmail, checkoutLinkId },
    })) as ToolResultEnvelope;
    steps.push({ step: 'sendPaymentEmail', output: email });

    console.log(JSON.stringify({ ok: email.result.ok, callSessionId: search.callSessionId, steps }, null, 2));
  });
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
