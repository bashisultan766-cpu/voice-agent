"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const webhook_reconciliation_util_1 = require("./webhook-reconciliation.util");
(0, node_test_1.default)('payment webhook event key is deterministic for idempotency', () => {
    const a = (0, webhook_reconciliation_util_1.buildPaymentWebhookEventKey)('orders/updated', '1001', 'tenant_1', 'checkout_1');
    const b = (0, webhook_reconciliation_util_1.buildPaymentWebhookEventKey)('orders/updated', '1001', 'tenant_1', 'checkout_1');
    strict_1.default.equal(a, b);
});
(0, node_test_1.default)('webhook payload minimization strips raw pii details', () => {
    const payload = (0, webhook_reconciliation_util_1.minimalWebhookPayload)('orders/create', {
        id: 44,
        name: '#10044',
        financial_status: 'paid',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:01:00.000Z',
        email: 'customer@example.com',
    });
    strict_1.default.deepEqual(payload, {
        topic: 'orders/create',
        orderId: '44',
        orderName: '#10044',
        financialStatus: 'paid',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
        cancelledAt: null,
        closedAt: null,
        maskedCustomerEmail: 'c***@example.com',
    });
});
//# sourceMappingURL=webhook-reconciliation.util.test.js.map