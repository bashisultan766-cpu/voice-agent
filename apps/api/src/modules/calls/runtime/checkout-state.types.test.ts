import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidCheckoutState,
  CheckoutState,
  isVoiceCheckoutState,
  VOICE_CHECKOUT_STATES,
} from './checkout-state.types';

test('assertValidCheckoutState accepts every canonical literal', () => {
  for (const state of VOICE_CHECKOUT_STATES) {
    assert.doesNotThrow(() => assertValidCheckoutState(state));
  }
});

test('assertValidCheckoutState rejects unknown strings', () => {
  assert.throws(() => assertValidCheckoutState('NOT_A_STATE'), /Invalid checkout state/);
  assert.equal(isVoiceCheckoutState('EMAIL_COLLECTION_REQUIRED'), true);
  assert.equal(isVoiceCheckoutState('EMAIL_REQUESTED'), true);
  assert.equal(isVoiceCheckoutState('EMAIL_CONFIRMATION_REQUIRED'), true);
});

test('CheckoutState constants match union members', () => {
  for (const value of Object.values(CheckoutState)) {
    assertValidCheckoutState(value);
  }
});
