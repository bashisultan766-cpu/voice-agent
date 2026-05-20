"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ops_service_1 = require("../modules/ops/ops.service");
const prisma_service_1 = require("../database/prisma.service");
const dev_script_context_1 = require("./dev-script-context");
function readDataObject(result) {
    return result.data && typeof result.data === 'object' && !Array.isArray(result.data)
        ? result.data
        : {};
}
async function run() {
    const tenantId = (0, dev_script_context_1.requireEnv)('DEV_TENANT_ID');
    const agentId = (0, dev_script_context_1.requireEnv)('DEV_AGENT_ID');
    const productQuery = (0, dev_script_context_1.optionalEnv)('DEV_FLOW_QUERY') || 'demo';
    const customerEmail = (0, dev_script_context_1.optionalEnv)('DEV_TEST_CUSTOMER_EMAIL') || 'demo.customer@example.com';
    const sendEmail = process.env.DEV_FLOW_SEND_EMAIL !== 'false';
    const callSessionId = (0, dev_script_context_1.optionalEnv)('DEV_CALL_SESSION_ID');
    const checkoutMode = (0, dev_script_context_1.optionalEnv)('DEV_TEST_CHECKOUT_MODE');
    await (0, dev_script_context_1.withDevAppContext)(async (app) => {
        const prisma = app.get(prisma_service_1.PrismaService);
        await (0, dev_script_context_1.assertTenantAgentContext)(prisma, tenantId, agentId);
        const ops = app.get(ops_service_1.OpsService);
        const steps = [];
        const search = (await ops.simulateToolCall(tenantId, agentId, {
            callSessionId,
            toolName: 'searchProducts',
            args: { query: productQuery, limit: 5 },
        }));
        steps.push({ step: 'searchProducts', output: search });
        if (!search.result.ok) {
            console.log(JSON.stringify({ ok: false, reason: 'search failed', steps }, null, 2));
            return;
        }
        const searchData = readDataObject(search.result);
        const results = Array.isArray(searchData.results) ? searchData.results : [];
        const first = results[0];
        if (!first) {
            console.log(JSON.stringify({ ok: false, reason: 'no products found', steps }, null, 2));
            return;
        }
        const productId = typeof first.id === 'string' ? first.id : '';
        const variants = Array.isArray(first.variants) ? first.variants : [];
        const firstVariantId = typeof variants[0]?.id === 'string' ? variants[0].id : '';
        const details = (await ops.simulateToolCall(tenantId, agentId, {
            callSessionId: search.callSessionId,
            toolName: 'getProductDetails',
            args: { productId, variantId: firstVariantId || undefined },
        }));
        steps.push({ step: 'getProductDetails', output: details });
        if (!details.result.ok) {
            console.log(JSON.stringify({ ok: false, reason: 'details failed', steps }, null, 2));
            return;
        }
        const checkoutArgs = {
            email: customerEmail,
            items: [{ variantId: firstVariantId || productId, quantity: 1 }],
            forceNewCheckout: false,
        };
        if (checkoutMode)
            checkoutArgs.mode = checkoutMode;
        const checkout = (await ops.simulateToolCall(tenantId, agentId, {
            callSessionId: search.callSessionId,
            toolName: 'createCheckoutLink',
            args: checkoutArgs,
        }));
        steps.push({ step: 'createCheckoutLink', output: checkout });
        if (!checkout.result.ok || !sendEmail) {
            console.log(JSON.stringify({ ok: checkout.result.ok, steps }, null, 2));
            return;
        }
        const checkoutData = readDataObject(checkout.result);
        const checkoutLinkId = typeof checkoutData.checkoutLinkId === 'string' ? checkoutData.checkoutLinkId : '';
        if (!checkoutLinkId) {
            console.log(JSON.stringify({ ok: false, reason: 'checkoutLinkId missing', steps }, null, 2));
            return;
        }
        const email = (await ops.simulateToolCall(tenantId, agentId, {
            callSessionId: search.callSessionId,
            toolName: 'sendPaymentEmail',
            args: { email: customerEmail, checkoutLinkId },
        }));
        steps.push({ step: 'sendPaymentEmail', output: email });
        console.log(JSON.stringify({ ok: email.result.ok, callSessionId: search.callSessionId, steps }, null, 2));
    });
}
run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
//# sourceMappingURL=simulate-voice-flow.js.map