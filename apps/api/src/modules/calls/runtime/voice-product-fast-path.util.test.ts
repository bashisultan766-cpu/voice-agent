import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeterministicProductReply,
  extractProductSearchQuery,
  isProductFastPathQuery,
  shouldBypassOpenAIForVoiceTurn,
  shouldSkipNormalizationForProductFastPath,
} from './voice-product-fast-path.util';

test('Do you have Atomic Habits uses product fast path', () => {
  assert.equal(isProductFastPathQuery({ text: 'Do you have Atomic Habits?' }), true);
  const bypass = shouldBypassOpenAIForVoiceTurn({
    text: 'Do you have Atomic Habits?',
    intent: 'product_search',
    orderState: 'IDLE',
  });
  assert.equal(bypass.useProductFastPath, true);
  assert.equal(bypass.bypassOpenAI, true);
});

test('I need Orange Crush uses product fast path', () => {
  assert.equal(isProductFastPathQuery({ text: 'I need Orange Crush' }), true);
  assert.equal(extractProductSearchQuery('I need Orange Crush'), 'Orange Crush');
});

test('deterministic reply for found product includes title', () => {
  const reply = buildDeterministicProductReply({
    products: [
      {
        id: '1',
        productId: '1',
        title: 'Atomic Habits',
        status: 'ACTIVE',
        variants: [{ id: 'v1', title: 'Default', inventory_quantity: 5, price: '14.99' }],
        relevanceScore: 900,
      },
    ],
    topScore: 900,
  });
  assert.match(reply, /Atomic Habits/i);
  assert.match(reply, /14\.99/);
  assert.ok(reply.split(/\s+/).length <= 20);
});

test('not found uses short deterministic fallback', () => {
  const reply = buildDeterministicProductReply({ products: [], topScore: 0 });
  assert.match(reply, /couldn't find the exact title/i);
});

test('how much is this book bypasses with discussed product', () => {
  const bypass = shouldBypassOpenAIForVoiceTurn({
    text: 'how much is this book',
    intent: 'product_question',
    orderState: 'IDLE',
    hasDiscussedProduct: true,
  });
  assert.equal(bypass.useProductFastPath, true);
});

test('recommendation requests do not use product fast path', () => {
  assert.equal(
    isProductFastPathQuery({ text: 'can you recommend a good mystery book' }),
    false,
  );
});

test('skip normalization for clear short product queries', () => {
  assert.equal(
    shouldSkipNormalizationForProductFastPath('do you have atomic habits', 'unchanged'),
    true,
  );
});

test('one copy in checkout does not use product search fast path', () => {
  const bypass = shouldBypassOpenAIForVoiceTurn({
    text: 'one copy',
    intent: 'purchase_confirmation',
    orderState: 'EMAIL_COLLECTION',
  });
  assert.equal(bypass.useProductFastPath, false);
});

test('What is your service does not use product fast path', () => {
  assert.equal(isProductFastPathQuery({ text: 'What is your service?' }), false);
});

test('Can you help me does not use product fast path', () => {
  assert.equal(isProductFastPathQuery({ text: 'Can you help me?' }), false);
});

test('I want Harry Potter uses product fast path', () => {
  assert.equal(isProductFastPathQuery({ text: 'I want Harry Potter' }), true);
});
