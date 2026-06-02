import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePaymentEmailConfirmed } from './resolve-payment-email-confirmed.util';

test('resolvePaymentEmailConfirmed coerces yes/1/true strings', () => {
  assert.equal(
    resolvePaymentEmailConfirmed({
      body: { parameters: { email_confirmed: 'yes' } },
      callSid: 'CA1',
    }),
    true,
  );
  assert.equal(
    resolvePaymentEmailConfirmed({
      body: { parameters: { emailConfirmed: '1' } },
    }),
    true,
  );
  assert.equal(
    resolvePaymentEmailConfirmed({
      body: { parameters: { email_confirmed: 'no' } },
    }),
    false,
  );
});

test('resolvePaymentEmailConfirmed respects explicit true', () => {
  assert.equal(
    resolvePaymentEmailConfirmed({
      fromTool: true,
      body: {},
      callSid: 'CA123',
    }),
    true,
  );
});

test('resolvePaymentEmailConfirmed respects explicit false even with callSid', () => {
  assert.equal(
    resolvePaymentEmailConfirmed({
      fromTool: false,
      body: { parameters: { email: 'a@b.com' } },
      callSid: 'CA123',
    }),
    false,
  );
});

test('resolvePaymentEmailConfirmed infers true when ElevenLabs omits boolean but callSid present', () => {
  assert.equal(
    resolvePaymentEmailConfirmed({
      body: {
        parameters: {
          email: 'jessica@sureshotbooks.com',
          variantId: 'gid://shopify/ProductVariant/1',
          quantity: 1,
        },
      },
      callSid: 'CA5652b993f408284b47dd9ea9c8b2128a',
    }),
    true,
  );
});

test('resolvePaymentEmailConfirmed defaults false without callSid', () => {
  assert.equal(
    resolvePaymentEmailConfirmed({
      body: { email: 'a@b.com', variantId: 'gid://shopify/ProductVariant/1', quantity: 1 },
    }),
    false,
  );
});
