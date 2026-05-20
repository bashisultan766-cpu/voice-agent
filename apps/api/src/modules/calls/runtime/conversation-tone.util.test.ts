import test from 'node:test';
import assert from 'node:assert/strict';
import { detectConversationTone, computeAllowPaymentSuggestion } from './conversation-tone.util';

test('detectConversationTone: short utterance without ? is direct', () => {
  assert.equal(detectConversationTone('yes'), 'direct');
});

test('detectConversationTone: thanks is friendly', () => {
  assert.equal(detectConversationTone('thanks so much'), 'friendly');
});

test('computeAllowPaymentSuggestion: purchase_confirmation', () => {
  assert.equal(
    computeAllowPaymentSuggestion({
      userIntent: 'purchase_confirmation',
      clsIntent: 'product_search',
      orderState: 'PRODUCT_DISCOVERY',
    }),
    true,
  );
});

test('computeAllowPaymentSuggestion: browsing product_search only', () => {
  assert.equal(
    computeAllowPaymentSuggestion({
      userIntent: 'product_search',
      clsIntent: 'product_search',
      orderState: 'PRODUCT_DISCOVERY',
    }),
    false,
  );
});
