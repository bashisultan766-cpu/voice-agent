import test from 'node:test';
import assert from 'node:assert/strict';
import { decideResponseMode } from './response-mode.util';

test('uses openai for exact catalog match (natural conversation)', () => {
  const mode = decideResponseMode({
    intent: 'product_search',
    state: 'PRODUCT_DISCOVERY',
    toolResult: {
      searchProducts: {
        ok: true,
        found: true,
        title: 'Dune',
        price: '$12',
        requiresClarification: false,
      },
    },
    customerText: 'Do you have Atomic Habits?',
  });
  assert.equal(mode, 'openai');
});

test('uses openai in email collection without tool trace', () => {
  const mode = decideResponseMode({
    intent: 'purchase_confirmation',
    state: 'EMAIL_COLLECTION',
    customerText: 'Yes send link',
  });
  assert.equal(mode, 'openai');
});

test('uses openai when customer speaks an email but no validateEmail tool trace yet', () => {
  const mode = decideResponseMode({
    intent: 'email_provided',
    state: 'PRODUCT_DISCOVERY',
    customerText: 'my email is reader@example.com',
  });
  assert.equal(mode, 'openai');
});

test('uses openai for greeting', () => {
  const mode = decideResponseMode({
    intent: 'greeting',
    state: 'IDLE',
    customerText: 'hello there',
  });
  assert.equal(mode, 'openai');
});

test('uses openai for product question with existing context', () => {
  const mode = decideResponseMode({
    intent: 'product_question',
    state: 'PRODUCT_DISCOVERY',
    customerText: "What's the price?",
  });
  assert.equal(mode, 'openai');
});

test('uses openai for payment email tool trace (success or failure)', () => {
  const modeOk = decideResponseMode({
    intent: 'email_provided',
    state: 'EMAIL_COLLECTION',
    customerText: 'reader@example.com',
    toolResult: {
      sendPaymentEmail: {
        ok: true,
        email: 'reader@example.com',
      },
    },
  });
  assert.equal(modeOk, 'openai');

  const modeFail = decideResponseMode({
    intent: 'email_provided',
    state: 'EMAIL_COLLECTION',
    customerText: 'reader@example.com',
    toolResult: {
      sendPaymentEmail: {
        ok: false,
        email: 'reader@example.com',
      },
    },
  });
  assert.equal(modeFail, 'openai');
});

test('uses openai for Shopify catalog hard failure', () => {
  const mode = decideResponseMode({
    intent: 'product_search',
    state: 'PRODUCT_DISCOVERY',
    toolResult: {
      searchProducts: {
        ok: false,
        found: false,
        requiresClarification: false,
        errorCode: 'SHOPIFY_SEARCH_FAILED',
      },
    },
    customerText: 'Dune',
  });
  assert.equal(mode, 'openai');
});

test('uses openai when search tool blocked by policy (not a catalog outage)', () => {
  const mode = decideResponseMode({
    intent: 'greeting',
    state: 'IDLE',
    toolResult: {
      searchProducts: {
        ok: false,
        found: false,
        requiresClarification: false,
        errorCode: 'TOOL_BLOCKED_BY_INTENT',
      },
    },
    customerText: 'hi',
  });
  assert.equal(mode, 'openai');
});

test('uses template for invalid email from validateEmail tool', () => {
  const mode = decideResponseMode({
    intent: 'email_provided',
    state: 'EMAIL_COLLECTION',
    toolResult: {
      validateEmail: { valid: false, email: null },
    },
    customerText: 'not an email',
  });
  assert.equal(mode, 'template');
});

test('uses openai for small talk', () => {
  const mode = decideResponseMode({
    intent: 'small_talk',
    state: 'PRODUCT_DISCOVERY',
    customerText: 'how are you?',
  });
  assert.equal(mode, 'openai');
});
