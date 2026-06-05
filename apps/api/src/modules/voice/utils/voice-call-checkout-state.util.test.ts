import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hydrateCheckoutStateFromCheckoutLinks,
  mergeCheckoutSessionState,
} from './voice-call-checkout-state.util';

test('hydrateCheckoutStateFromCheckoutLinks rebuilds batch from prior checkout links', () => {
  const hydrated = hydrateCheckoutStateFromCheckoutLinks(
    [
      {
        id: 'cl-1',
        providerRef: 'gid://shopify/DraftOrder/1',
        checkoutUrl: 'https://shop.example/invoice-1',
        customerEmail: 'buyer@gmail.com',
        itemsJson: [
          {
            title: 'Book A',
            quantity: 1,
            price: '9.99',
            variantId: 'gid://shopify/ProductVariant/1',
          },
        ],
        metadata: { callSid: 'CA_test', shopifyInvoiceSent: true },
        status: 'SENT',
        sentAt: new Date('2026-06-05T17:29:11.000Z'),
        createdAt: new Date('2026-06-05T17:29:11.000Z'),
      },
    ],
    { callSid: 'CA_test', email: 'buyer@gmail.com' },
  );

  assert.equal(hydrated.recipients.length, 1);
  assert.equal(hydrated.batches['buyer@gmail.com']?.draftOrderId, 'gid://shopify/DraftOrder/1');
  assert.equal(hydrated.batches['buyer@gmail.com']?.shopifyInvoiceSent, true);
  assert.equal(hydrated.batches['buyer@gmail.com']?.lines.length, 1);
});

test('mergeCheckoutSessionState prefers session metadata when present', () => {
  const merged = mergeCheckoutSessionState({
    sessionRecipients: [
      {
        productId: 'p1',
        productTitle: 'A',
        recipientEmail: 'buyer@gmail.com',
        paymentStatus: 'link_sent',
      },
    ],
    sessionBatches: {
      'buyer@gmail.com': {
        recipientEmail: 'buyer@gmail.com',
        draftOrderId: 'draft-session',
        shopifyInvoiceSent: true,
        lines: [],
        status: 'invoiced',
      },
    },
    hydratedRecipients: [],
    hydratedBatches: {},
  });

  assert.equal(merged.hydrated, false);
  assert.equal(merged.recipients.length, 1);
  assert.equal(merged.batches['buyer@gmail.com']?.draftOrderId, 'draft-session');
});
