import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFinalizeOnlyRequest,
  resolveVoiceFinalizeCheckout,
} from './resolve-voice-finalize-checkout.util';

test('resolveVoiceFinalizeCheckout honors explicit true/false', () => {
  assert.equal(resolveVoiceFinalizeCheckout({ explicit: true, email: 'a@b.com', batches: {} }), true);
  assert.equal(resolveVoiceFinalizeCheckout({ explicit: false, email: 'a@b.com', batches: {} }), false);
});

test('resolveVoiceFinalizeCheckout auto-finalizes first book only', () => {
  const batches = {
    'john@gmail.com': {
      recipientEmail: 'john@gmail.com',
      draftOrderId: null,
      shopifyInvoiceSent: false,
      lines: [
        {
          productId: 'v1',
          variantId: 'gid://shopify/ProductVariant/1',
          productTitle: 'Book A',
          quantity: 1,
        },
      ],
      status: 'accumulating' as const,
    },
  };
  assert.equal(
    resolveVoiceFinalizeCheckout({ email: 'john@gmail.com', batches }),
    false,
  );
  assert.equal(resolveVoiceFinalizeCheckout({ email: 'john@gmail.com', batches: {} }), true);
});

test('isFinalizeOnlyRequest detects send-all without a new product', () => {
  assert.equal(
    isFinalizeOnlyRequest({ finalizeCheckout: true, variantId: '', productName: '' }),
    true,
  );
  assert.equal(
    isFinalizeOnlyRequest({ finalizeCheckout: true, productName: 'Atomic Habits' }),
    false,
  );
});
