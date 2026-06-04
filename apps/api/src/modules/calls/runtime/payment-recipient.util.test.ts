import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPaymentRecipientsSummary,
  findPaymentRecipient,
  isDuplicatePaymentRecipient,
  markRecipientEmailConfirmed,
  markRecipientPaymentSent,
  parsePaymentRecipients,
  paymentRecipientPairKey,
  upsertPaymentRecipient,
  wantsAnotherBookOnCall,
} from './payment-recipient.util';

test('parsePaymentRecipients filters invalid rows', () => {
  const rows = parsePaymentRecipients([
    { productId: 'p1', productTitle: 'Book A', recipientEmail: 'a@b.com', paymentStatus: 'link_sent' },
    { productId: '', productTitle: 'X', recipientEmail: 'x@y.com', paymentStatus: 'link_sent' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.productTitle, 'Book A');
});

test('paymentRecipientPairKey is stable per product and email', () => {
  const a = paymentRecipientPairKey('gid://shopify/Product/1', 'John@gmail.com');
  const b = paymentRecipientPairKey('gid://shopify/Product/1', 'john@gmail.com');
  assert.equal(a, b);
  assert.notEqual(a, paymentRecipientPairKey('gid://shopify/Product/2', 'john@gmail.com'));
});

test('isDuplicatePaymentRecipient blocks repeat link_sent', () => {
  const recipients = [
    {
      productId: 'p1',
      productTitle: 'Capital Seven',
      recipientEmail: 'john@gmail.com',
      paymentStatus: 'link_sent' as const,
    },
  ];
  assert.equal(isDuplicatePaymentRecipient(recipients, 'p1', 'john@gmail.com'), true);
  assert.equal(isDuplicatePaymentRecipient(recipients, 'p1', 'jessica@gmail.com'), false);
});

test('markRecipientEmailConfirmed and markRecipientPaymentSent', () => {
  let recipients = markRecipientEmailConfirmed(
    [],
    { title: 'Illuminati', productId: 'p2', variantId: 'v2' },
    'jessica@gmail.com',
    1,
  );
  assert.equal(recipients[0]!.paymentStatus, 'email_confirmed');
  recipients = markRecipientPaymentSent(recipients, 'p2', 'jessica@gmail.com', {
    paymentLink: 'https://pay.example/1',
    draftOrderId: 'draft-1',
  });
  assert.equal(recipients[0]!.paymentStatus, 'link_sent');
  assert.equal(recipients[0]!.paymentLink, 'https://pay.example/1');
});

test('buildPaymentRecipientsSummary lists sent links', () => {
  const summary = buildPaymentRecipientsSummary([
    {
      productId: 'p1',
      productTitle: 'Capital Seven',
      recipientEmail: 'john@gmail.com',
      paymentStatus: 'link_sent',
    },
    {
      productId: 'p2',
      productTitle: 'GED Success',
      recipientEmail: 'alex@gmail.com',
      paymentStatus: 'email_confirmed',
    },
  ]);
  assert.match(summary, /Capital Seven/i);
  assert.match(summary, /gmail\.com/i);
  assert.doesNotMatch(summary, /GED Success/);
});

test('wantsAnotherBookOnCall detects continuation intent', () => {
  assert.equal(wantsAnotherBookOnCall('I want another book please'), true);
  assert.equal(wantsAnotherBookOnCall('thanks bye'), false);
});

test('findPaymentRecipient matches normalized email', () => {
  const list = upsertPaymentRecipient([], {
    productId: 'p1',
    productTitle: 'A',
    recipientEmail: 'john@gmail.com',
    paymentStatus: 'email_confirmed',
  });
  assert.ok(findPaymentRecipient(list, 'p1', 'John@Gmail.com'));
});
