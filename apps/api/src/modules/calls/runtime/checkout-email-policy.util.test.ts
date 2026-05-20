import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmailRequiredBeforeCheckout } from './checkout-email-policy.util';

test('blocks checkout when askEmailBeforePaymentLink is enabled and email missing', () => {
  assert.equal(
    isEmailRequiredBeforeCheckout({
      askEmailBeforePaymentLink: true,
      customerEmail: null,
      destinationEmail: null,
    }),
    true,
  );
});

test('allows checkout when email exists or policy disabled', () => {
  assert.equal(
    isEmailRequiredBeforeCheckout({
      askEmailBeforePaymentLink: true,
      customerEmail: 'customer@example.com',
    }),
    false,
  );
  assert.equal(
    isEmailRequiredBeforeCheckout({
      askEmailBeforePaymentLink: false,
      customerEmail: null,
      destinationEmail: null,
    }),
    false,
  );
});
