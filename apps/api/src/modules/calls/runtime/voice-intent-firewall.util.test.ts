import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUserIntent } from './user-intent-classifier.util';
import {
  buildConversationalSupportReply,
  computeProductIntentConfidence,
  evaluateProductSearchGate,
  isConversationalSupportQuery,
  matchNonProductSearchPattern,
} from './voice-intent-firewall.util';
import {
  isProductFastPathQuery,
  shouldBypassOpenAIForVoiceTurn,
} from './voice-product-fast-path.util';

test('What is your service routes to conversational support not product search', () => {
  const text = 'What is your service?';
  const intent = classifyUserIntent(text);
  assert.equal(isConversationalSupportQuery(text, intent), true);
  assert.equal(isProductFastPathQuery({ text, intent }), false);

  const bypass = shouldBypassOpenAIForVoiceTurn({ text, intent, orderState: 'IDLE' });
  assert.equal(bypass.useConversationalSupport, true);
  assert.equal(bypass.useProductFastPath, false);
  assert.equal(bypass.openaiSkippedReason, 'conversational_support');
});

test('Who are you routes to conversational support', () => {
  const text = 'Who are you?';
  const intent = classifyUserIntent(text);
  assert.equal(intent, 'store_identity_question');
  assert.equal(isConversationalSupportQuery(text, intent), true);
  assert.equal(isProductFastPathQuery({ text, intent }), false);

  const bypass = shouldBypassOpenAIForVoiceTurn({ text, intent, orderState: 'IDLE' });
  assert.equal(bypass.useConversationalSupport, true);
  assert.equal(bypass.useProductFastPath, false);
});

test('Can you help me routes to conversational support', () => {
  const text = 'Can you help me?';
  const intent = classifyUserIntent(text);
  assert.equal(isConversationalSupportQuery(text, intent), true);
  assert.equal(isProductFastPathQuery({ text, intent }), false);

  const bypass = shouldBypassOpenAIForVoiceTurn({ text, intent, orderState: 'IDLE' });
  assert.equal(bypass.useConversationalSupport, true);
  assert.equal(bypass.useProductFastPath, false);
});

test('Do you have Atomic Habits uses deterministic product fast path', () => {
  const text = 'Do you have Atomic Habits?';
  const intent = classifyUserIntent(text);
  assert.equal(isConversationalSupportQuery(text, intent), false);
  assert.equal(isProductFastPathQuery({ text, intent }), true);

  const bypass = shouldBypassOpenAIForVoiceTurn({ text, intent, orderState: 'IDLE' });
  assert.equal(bypass.useProductFastPath, true);
  assert.equal(bypass.useConversationalSupport, undefined);
  assert.equal(bypass.openaiSkippedReason, 'deterministic_product_fast_path');
});

test('I want Harry Potter uses deterministic product fast path', () => {
  const text = 'I want Harry Potter';
  const intent = classifyUserIntent(text);
  assert.equal(isProductFastPathQuery({ text, intent }), true);

  const bypass = shouldBypassOpenAIForVoiceTurn({ text, intent, orderState: 'IDLE' });
  assert.equal(bypass.useProductFastPath, true);
});

test('non-product blocklist matches support phrases', () => {
  assert.equal(matchNonProductSearchPattern('tell me about yourself').matched, true);
  assert.equal(matchNonProductSearchPattern('how does this work').matched, true);
  assert.equal(matchNonProductSearchPattern('do you have atomic habits').matched, false);
});

test('conversational support reply is deterministic without search language', () => {
  const reply = buildConversationalSupportReply('What is your service?', 'capability_question');
  assert.match(reply, /help|book|order/i);
  assert.doesNotMatch(reply.toLowerCase(), /let me check/i);
});

test('product confidence gate blocks vague five-word queries', () => {
  const gate = evaluateProductSearchGate({
    text: 'What is your service?',
    intent: 'product_search',
  });
  assert.equal(gate.allowProductSearch, false);
  assert.ok(gate.confidence < 0.75);
});

test('product confidence passes explicit commerce with title', () => {
  const confidence = computeProductIntentConfidence('Do you have Atomic Habits?', 'product_search');
  assert.ok(confidence >= 0.75);
});
