import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentWebhookEventKey, minimalWebhookPayload } from './webhook-reconciliation.util';

test('payment webhook event key is deterministic for idempotency', () => {
  const a = buildPaymentWebhookEventKey('orders/updated', '1001', 'tenant_1', 'checkout_1');
  const b = buildPaymentWebhookEventKey('orders/updated', '1001', 'tenant_1', 'checkout_1');
  assert.equal(a, b);
});

test('webhook payload minimization strips raw pii details', () => {
  const payload = minimalWebhookPayload('orders/create', {
    id: 44,
    name: '#10044',
    financial_status: 'paid',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z',
    email: 'customer@example.com',
  });

  assert.deepEqual(payload, {
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
