import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextAwareReply } from './context-aware-reply.util';

const baseTone = {
  conversationTone: 'neutral' as const,
  lastToneLeadUsed: null as string | null,
  allowPaymentSuggestion: false,
  followUpOfferedProductKey: null as string | null,
};

test('answers price question first from conversation history — one sentence, no payment pitch', () => {
  const r = buildContextAwareReply({
    intent: 'product_question',
    state: 'PRODUCT_DISCOVERY',
    previousState: 'PRODUCT_DISCOVERY',
    lastUserMessage: "What's the price?",
    conversationHistory: [
      {
        role: 'assistant',
        content:
          "Yes, I found Dune. It's available for $12. I can send you the payment link if you'd like.",
      },
    ],
    ...baseTone,
  });
  assert.ok(r);
  assert.equal(r?.questionAnsweredFirst, true);
  assert.match(r?.text ?? '', /\$12/);
  assert.equal(r?.paymentSuggestionUsed, false);
  assert.equal((r?.text.match(/\./g) ?? []).length, 1);
});

test('defers store identity to OpenAI (no canned script)', () => {
  const r = buildContextAwareReply({
    intent: 'store_identity_question',
    state: 'IDLE',
    previousState: 'IDLE',
    lastUserMessage: 'What store is this?',
    conversationHistory: [],
    ...baseTone,
  });
  assert.equal(r, null);
});

test('handles correction without "let me check" phrasing', () => {
  const r = buildContextAwareReply({
    intent: 'correction',
    state: 'PRODUCT_DISCOVERY',
    previousState: 'PRODUCT_DISCOVERY',
    lastUserMessage: 'No, I meant paperback',
    conversationHistory: [],
    ...baseTone,
  });
  assert.ok(r);
  assert.equal(r?.interruptionHandled, true);
  assert.match(r?.text ?? '', /paperback/i);
  assert.doesNotMatch(r?.text ?? '', /let me check/i);
});

test('skips repeating Got it when last lead was Got it', () => {
  const r = buildContextAwareReply({
    intent: 'correction',
    state: 'PRODUCT_DISCOVERY',
    previousState: 'PRODUCT_DISCOVERY',
    lastUserMessage: 'No, hardcover',
    conversationHistory: [],
    conversationTone: 'neutral',
    lastToneLeadUsed: 'Got it,',
    allowPaymentSuggestion: false,
    followUpOfferedProductKey: null,
  });
  assert.ok(r);
  assert.doesNotMatch(r?.text ?? '', /^Got it,/);
});

test('purchase flow copy comes from OpenAI, not context-aware templates', () => {
  const r = buildContextAwareReply({
    intent: 'purchase_confirmation',
    state: 'IDLE',
    previousState: 'IDLE',
    lastUserMessage: 'Yes, I want to buy',
    conversationHistory: [],
    ...baseTone,
  });
  assert.equal(r, null);
});
