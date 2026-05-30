import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractProductSearchQuery,
  isContextualAcknowledgment,
  isRepeatOrClarificationRequest,
  isWeakProductSearchQuery,
  requiresOpenAiProductReasoning,
} from './voice-product-query.util';
import { evaluateProductSearchGate } from './voice-intent-firewall.util';
import { classifyUserIntent } from './user-intent-classifier.util';

test('extracts title from give me the book phrasing', () => {
  const q = extractProductSearchQuery('Okay.  give me the book, the Cardinal 7 eliminate');
  assert.match(q, /cardinal\s+7\s+eliminate/i);
});

test('weak queries blocked from product gate', () => {
  assert.equal(isWeakProductSearchQuery('tell me'), true);
  assert.equal(
    evaluateProductSearchGate({
      text: 'So, please check and tell me.',
      intent: 'product_search',
    }).allowProductSearch,
    false,
  );
});

test('similar book requests need OpenAI not fast path', () => {
  assert.equal(requiresOpenAiProductReasoning('I uh give me a similar titles'), true);
  assert.equal(
    evaluateProductSearchGate({
      text: 'So, please give me the similar book.',
      intent: 'product_search',
    }).allowProductSearch,
    false,
  );
});

test('what are you doing is small talk not capability', () => {
  assert.equal(classifyUserIntent('What are you doing now?'), 'small_talk');
});

test('okay please is contextual ack', () => {
  assert.equal(isContextualAcknowledgment('Okay, please.'), true);
});

test('say it again is repeat not product search', () => {
  assert.equal(isRepeatOrClarificationRequest('Which 1 say it again?'), true);
  assert.equal(
    evaluateProductSearchGate({
      text: 'Which 1 say it again?',
      intent: 'product_search',
    }).allowProductSearch,
    false,
  );
});
