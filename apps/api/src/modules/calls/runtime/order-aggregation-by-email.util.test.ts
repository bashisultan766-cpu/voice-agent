import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  batchAfterSuccessfulInvoice,
  buildCheckoutExecutionPlan,
  checkoutSessionIdempotencyKey,
  parseEmailCheckoutBatches,
  recipientsAfterAggregatedSend,
} from './order-aggregation-by-email.util';
import { markRecipientPaymentSent } from './payment-recipient.util';

test('buildCheckoutExecutionPlan queues products without finalizing', () => {
  const plan = buildCheckoutExecutionPlan({
    recipients: [],
    batches: {},
    email: 'john@gmail.com',
    callSid: 'CA123',
    current: {
      productId: 'p1',
      variantId: 'v1',
      productTitle: 'Capital Seven',
      quantity: 1,
    },
    finalizeCheckout: false,
  });
  assert.equal(plan.aggregationMode, 'queue');
  assert.equal(plan.lines.length, 1);
  assert.equal(plan.sendShopifyInvoice, false);
  assert.equal(plan.skipResendEmail, true);
});

test('buildCheckoutExecutionPlan finalizes all queued lines into one create', () => {
  const batches = parseEmailCheckoutBatches({
    'john@gmail.com': {
      recipientEmail: 'john@gmail.com',
      draftOrderId: null,
      shopifyInvoiceSent: false,
      status: 'accumulating',
      lines: [
        {
          productId: 'p1',
          variantId: 'v1',
          productTitle: 'Capital Seven',
          quantity: 1,
        },
      ],
    },
  });
  const plan = buildCheckoutExecutionPlan({
    recipients: [],
    batches,
    email: 'john@gmail.com',
    callSid: 'CA123',
    current: {
      productId: 'p2',
      variantId: 'v2',
      productTitle: 'Illuminati',
      quantity: 1,
    },
    finalizeCheckout: true,
  });
  assert.equal(plan.aggregationMode, 'create');
  assert.equal(plan.lines.length, 2);
  assert.equal(plan.sendShopifyInvoice, true);
});

test('buildCheckoutExecutionPlan re-sends invoice when new products are added to invoiced draft', () => {
  const batches = parseEmailCheckoutBatches({
    'john@gmail.com': {
      recipientEmail: 'john@gmail.com',
      draftOrderId: 'draft-1',
      shopifyInvoiceSent: true,
      status: 'invoiced',
      invoicedLinesFingerprint: 'v1:1',
      lines: [
        {
          productId: 'p1',
          variantId: 'v1',
          productTitle: 'Capital Seven',
          quantity: 1,
        },
      ],
    },
  });
  const plan = buildCheckoutExecutionPlan({
    recipients: markRecipientPaymentSent([], 'p1', 'john@gmail.com', {
      draftOrderId: 'draft-1',
      paymentLink: 'https://pay/1',
      variantId: 'v1',
      productTitle: 'Capital Seven',
    }),
    batches,
    email: 'john@gmail.com',
    callSid: 'CA123',
    current: {
      productId: 'p2',
      variantId: 'v2',
      productTitle: 'Illuminati',
      quantity: 1,
    },
    finalizeCheckout: true,
  });
  assert.equal(plan.aggregationMode, 'update');
  assert.equal(plan.lines.length, 2);
  assert.equal(plan.sendShopifyInvoice, true);
  assert.equal(plan.skipResendEmail, false);
});

test('buildCheckoutExecutionPlan skips re-invoice when invoiced lines are unchanged', () => {
  const batches = parseEmailCheckoutBatches({
    'john@gmail.com': {
      recipientEmail: 'john@gmail.com',
      draftOrderId: 'draft-1',
      shopifyInvoiceSent: true,
      status: 'invoiced',
      invoicedLinesFingerprint: 'v1:1|v2:1',
      lines: [
        {
          productId: 'p1',
          variantId: 'v1',
          productTitle: 'Capital Seven',
          quantity: 1,
        },
        {
          productId: 'p2',
          variantId: 'v2',
          productTitle: 'Illuminati',
          quantity: 1,
        },
      ],
    },
  });
  const plan = buildCheckoutExecutionPlan({
    recipients: [],
    batches,
    email: 'john@gmail.com',
    callSid: 'CA123',
    current: {
      productId: 'p2',
      variantId: 'v2',
      productTitle: 'Illuminati',
      quantity: 1,
    },
    finalizeCheckout: true,
  });
  assert.equal(plan.aggregationMode, 'duplicate_prevented');
  assert.equal(plan.sendShopifyInvoice, false);
});

test('buildCheckoutExecutionPlan prevents duplicate finalize invoice', () => {
  const batches = parseEmailCheckoutBatches({
    'john@gmail.com': {
      recipientEmail: 'john@gmail.com',
      draftOrderId: 'draft-1',
      shopifyInvoiceSent: true,
      status: 'invoiced',
      invoicedLinesFingerprint: 'v1:1',
      lines: [
        {
          productId: 'p1',
          variantId: 'v1',
          productTitle: 'Capital Seven',
          quantity: 1,
        },
      ],
    },
  });
  const plan = buildCheckoutExecutionPlan({
    recipients: [],
    batches,
    email: 'john@gmail.com',
    callSid: 'CA123',
    current: {
      productId: 'p1',
      variantId: 'v1',
      productTitle: 'Capital Seven',
      quantity: 1,
    },
    finalizeCheckout: true,
  });
  assert.equal(plan.aggregationMode, 'duplicate_prevented');
  assert.equal(plan.duplicateInvoicePrevented, true);
});

test('buildCheckoutExecutionPlan updates quantity when same variant re-finalized with more copies', () => {
  const batches = parseEmailCheckoutBatches({
    'john@gmail.com': {
      recipientEmail: 'john@gmail.com',
      draftOrderId: 'draft-1',
      shopifyInvoiceSent: true,
      status: 'invoiced',
      invoicedLinesFingerprint: 'v1:1',
      lines: [
        {
          productId: 'p1',
          variantId: 'v1',
          productTitle: 'Capital Seven',
          quantity: 1,
        },
      ],
    },
  });
  const plan = buildCheckoutExecutionPlan({
    recipients: [],
    batches,
    email: 'john@gmail.com',
    callSid: 'CA123',
    current: {
      productId: 'p1',
      variantId: 'v1',
      productTitle: 'Capital Seven',
      quantity: 2,
    },
    finalizeCheckout: true,
  });
  assert.equal(plan.aggregationMode, 'update');
  assert.equal(plan.lines[0]!.quantity, 3);
});

test('checkoutSessionIdempotencyKey is stable for callSid email draftOrderId', () => {
  const a = checkoutSessionIdempotencyKey('CA1', 'john@gmail.com', 'draft-1');
  const b = checkoutSessionIdempotencyKey('CA1', 'John@Gmail.com', 'draft-1');
  assert.equal(a, b);
});

test('recipientsAfterAggregatedSend marks included products link_sent', () => {
  const next = recipientsAfterAggregatedSend(
    [
      {
        productId: 'p1',
        productTitle: 'A',
        recipientEmail: 'john@gmail.com',
        paymentStatus: 'email_confirmed',
      },
      {
        productId: 'p2',
        productTitle: 'B',
        recipientEmail: 'john@gmail.com',
        paymentStatus: 'email_confirmed',
      },
    ],
    'john@gmail.com',
    {
      draftOrderId: 'draft-1',
      paymentLink: 'https://pay/1',
      checkoutLinkId: 'cl-1',
      productIds: ['p1', 'p2'],
    },
  );
  assert.equal(next.every((r) => r.paymentStatus === 'link_sent'), true);
});

test('batchAfterSuccessfulInvoice marks batch invoiced', () => {
  const next = batchAfterSuccessfulInvoice(
    {
      recipientEmail: 'john@gmail.com',
      draftOrderId: null,
      shopifyInvoiceSent: false,
      lines: [],
      status: 'accumulating',
    },
    { draftOrderId: 'draft-1', shopifyInvoiceSent: true },
  );
  assert.equal(next.status, 'invoiced');
  assert.equal(next.shopifyInvoiceSent, true);
});
