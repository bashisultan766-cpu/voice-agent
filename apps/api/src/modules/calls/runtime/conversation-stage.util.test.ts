import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceConversationStage, shouldUseFastVoicePath } from './conversation-stage.util';

test('greeting intent stays in GREETING stage', () => {
  const r = advanceConversationStage({
    currentStage: 'GREETING',
    orderState: 'IDLE',
    userIntent: 'greeting',
    objection: null,
    hasProductDiscussed: false,
    paymentLinkSent: false,
    emailConfirmed: false,
  });
  assert.equal(r.nextStage, 'GREETING');
});

test('product search moves to DISCOVERY without prior product', () => {
  const r = advanceConversationStage({
    currentStage: 'GREETING',
    orderState: 'PRODUCT_DISCOVERY',
    userIntent: 'product_search',
    objection: null,
    hasProductDiscussed: false,
    paymentLinkSent: false,
    emailConfirmed: false,
  });
  assert.equal(r.nextStage, 'DISCOVERY');
});

test('objection forces OBJECTION_HANDLING', () => {
  const r = advanceConversationStage({
    currentStage: 'RECOMMENDATION',
    orderState: 'PRODUCT_DISCOVERY',
    userIntent: 'product_question',
    objection: 'too_expensive',
    hasProductDiscussed: true,
    paymentLinkSent: false,
    emailConfirmed: false,
  });
  assert.equal(r.nextStage, 'OBJECTION_HANDLING');
});

test('fast path for greeting without tools', () => {
  assert.equal(shouldUseFastVoicePath('greeting', 'GREETING', false), true);
  assert.equal(shouldUseFastVoicePath('product_search', 'DISCOVERY', true), false);
});
