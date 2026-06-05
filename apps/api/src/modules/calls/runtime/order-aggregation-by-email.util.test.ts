import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildEmailCheckoutPlan,
  emailPaymentLinkAlreadySent,
  findDraftOrderIdForEmail,
  recipientsAfterAggregatedSend,
} from './order-aggregation-by-email.util';
import { markRecipientPaymentSent } from './payment-recipient.util';

test('buildEmailCheckoutPlan batches email_confirmed products on create', () => {
  const plan = buildEmailCheckoutPlan(
    [
      {
        productId: 'p1',
        productTitle: 'Capital Seven',
        variantId: 'v1',
        recipientEmail: 'john@gmail.com',
        paymentStatus: 'email_confirmed',
        quantity: 1,
      },
      {
        productId: 'p2',
        productTitle: 'Illuminati',
        variantId: 'v2',
        recipientEmail: 'john@gmail.com',
        paymentStatus: 'email_confirmed',
        quantity: 1,
      },
    ],
    'john@gmail.com',
    {
      productId: 'p3',
      variantId: 'v3',
      productTitle: 'GED Success',
      quantity: 1,
    },
  );
  assert.equal(plan.mode, 'create');
  assert.equal(plan.lines.length, 3);
  assert.equal(plan.emailAlreadySentForEmail, false);
});

test('buildEmailCheckoutPlan updates existing draft for same email', () => {
  let recipients = markRecipientPaymentSent(
    [],
    'p1',
    'john@gmail.com',
    {
      paymentLink: 'https://pay/1',
      draftOrderId: 'draft-1',
      productTitle: 'Capital Seven',
      variantId: 'v1',
      quantity: 1,
    },
  );
  recipients = [
    ...recipients,
    {
      productId: 'p2',
      productTitle: 'Illuminati',
      variantId: 'v2',
      recipientEmail: 'john@gmail.com',
      paymentStatus: 'email_confirmed',
      quantity: 1,
    },
  ];
  const plan = buildEmailCheckoutPlan(recipients, 'john@gmail.com', {
    productId: 'p2',
    variantId: 'v2',
    productTitle: 'Illuminati',
    quantity: 1,
  });
  assert.equal(plan.mode, 'update');
  assert.equal(plan.existingDraftOrderId, 'draft-1');
  assert.equal(plan.lines.length, 2);
  assert.equal(plan.emailAlreadySentForEmail, true);
});

test('different emails stay independent', () => {
  const plan = buildEmailCheckoutPlan(
    [
      {
        productId: 'p1',
        productTitle: 'Capital Seven',
        variantId: 'v1',
        recipientEmail: 'john@gmail.com',
        paymentStatus: 'email_confirmed',
        quantity: 1,
      },
    ],
    'jessica@gmail.com',
    {
      productId: 'p2',
      variantId: 'v2',
      productTitle: 'Illuminati',
      quantity: 1,
    },
  );
  assert.equal(plan.mode, 'create');
  assert.equal(plan.lines.length, 1);
  assert.equal(plan.lines[0]!.productTitle, 'Illuminati');
});

test('findDraftOrderIdForEmail and emailPaymentLinkAlreadySent', () => {
  const recipients = markRecipientPaymentSent([], 'p1', 'john@gmail.com', {
    draftOrderId: 'draft-abc',
    paymentLink: 'https://pay/1',
  });
  assert.equal(findDraftOrderIdForEmail(recipients, 'john@gmail.com'), 'draft-abc');
  assert.equal(emailPaymentLinkAlreadySent(recipients, 'john@gmail.com'), true);
  assert.equal(emailPaymentLinkAlreadySent(recipients, 'jessica@gmail.com'), false);
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
  assert.equal(next[0]!.draftOrderId, 'draft-1');
});
