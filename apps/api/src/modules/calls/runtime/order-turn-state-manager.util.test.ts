import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTurnToOrderState } from './order-turn-state-manager.util';
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
