import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  paymentEmailIdempotencyKey,
  paymentRecipientPairIdempotencyKey,
} from './payment-email-idempotency';

test('paymentRecipientPairIdempotencyKey is stable for same product and email', () => {
  const a = paymentRecipientPairIdempotencyKey({
    tenantId: 't1',
    agentId: 'a1',
    productId: 'gid://shopify/Product/1',
    recipientEmail: 'John@gmail.com',
    callSid: 'CA123',
  });
  const b = paymentRecipientPairIdempotencyKey({
    tenantId: 't1',
    agentId: 'a1',
    productId: 'gid://shopify/Product/1',
    recipientEmail: 'john@gmail.com',
    callSid: 'CA123',
  });
  assert.equal(a, b);
  assert.notEqual(
    a,
    paymentRecipientPairIdempotencyKey({
      tenantId: 't1',
      agentId: 'a1',
      productId: 'gid://shopify/Product/2',
      recipientEmail: 'john@gmail.com',
      callSid: 'CA123',
    }),
  );
});

test('paymentEmailIdempotencyKey unchanged for checkout link id', () => {
  const key = paymentEmailIdempotencyKey({
    tenantId: 't1',
    agentId: 'a1',
    checkoutLinkId: 'link-1',
    recipientEmail: 'a@b.com',
  });
  assert.equal(key.length, 64);
});
