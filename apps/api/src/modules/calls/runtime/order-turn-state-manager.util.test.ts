import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTurnToOrderState, canInterruptCurrentState } from './order-turn-state-manager.util';
import { classifyOrderTurn } from './order-intent-classifier.util';

function step(state: string, utterance: string) {
  const cls = classifyOrderTurn(utterance);
  const res = applyTurnToOrderState(state, cls.intent, cls);
  return { cls, res };
}

test('bookstore flow: product search then confirm goes to email collection', () => {
  let s: string = 'IDLE';

  ({ res: { nextState: s } } = step(s, 'I want Atomic Habits'));
  assert.equal(s, 'PRODUCT_DISCOVERY');

  ({ res: { nextState: s } } = step(s, 'Yes'));
  assert.equal(s, 'EMAIL_COLLECTION');
});

test('unclear product: recovery prompt in discovery', () => {
  const { res } = step('PRODUCT_DISCOVERY', 'uhm');
  assert.equal(res.nextState, 'PRODUCT_DISCOVERY');
  assert.ok(res.recoveryPrompt);
});

test('invalid email retry: stays in EMAIL_COLLECTION', () => {
  const { res } = step('EMAIL_COLLECTION', 'not-an-email');
  assert.equal(res.nextState, 'EMAIL_COLLECTION');
  assert.equal(res.recoveryPrompt?.key, 'INVALID_EMAIL');
});

test('EMAIL_COLLECTION + product query interrupts recovery and returns to discovery', () => {
  const cls = classifyOrderTurn('You have Game of Thrones');
  const res = applyTurnToOrderState('EMAIL_COLLECTION', cls.intent, cls, {
    alternateIntent: 'product_search',
    alternateIntentConfidence: 0.92,
  });
  assert.equal(res.nextState, 'PRODUCT_DISCOVERY');
  assert.equal(res.recoveryPrompt, undefined);
  assert.equal(res.stateInterrupted?.toIntent, 'product_search');
});

test('interrupt rules require high confidence alternate intent', () => {
  const low = canInterruptCurrentState('product_search', 'EMAIL_COLLECTION', 0.4);
  assert.equal(low.canInterrupt, false);
  const high = canInterruptCurrentState('product_search', 'EMAIL_COLLECTION', 0.9);
  assert.equal(high.canInterrupt, true);
});

test('user cancels: transitions to DONE', () => {
  const { res } = step('PRODUCT_DISCOVERY', 'cancel order');
  assert.equal(res.nextState, 'DONE');
  assert.equal(res.recoveryPrompt?.key, 'CHANGED_MIND');
});

test('general question mid-order: stays in product discovery', () => {
  const { cls, res } = step('PRODUCT_DISCOVERY', 'What is your return policy?');
  assert.equal(cls.intent, 'general_question');
  assert.equal(res.nextState, 'PRODUCT_DISCOVERY');
});
