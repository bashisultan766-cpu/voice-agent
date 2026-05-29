import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLlmAgentState, mergeCallerSignalsIntoState } from './llm-agent-conversation-state.util';
import { EMAIL_SPELL_COLLECTION_PROMPT } from './voice-email-capture.util';
import { QUANTITY_PROMPT } from './book-sales-voice.util';
import {
  applyDeterministicProductSelection,
  containsForbiddenCheckoutPhrase,
  guardTransactionalReply,
  isCheckoutCartReady,
  resolveTransactionalCheckoutState,
  routeTransactionalCheckoutTurn,
  shouldBypassOpenAiGeneration,
} from './transactional-checkout-state.util';

const inStockProduct = {
  title: 'World History Vol 1',
  variantId: 'gid://shopify/ProductVariant/99',
  inStock: true,
  stock: 8,
};

test('resolveTransactionalCheckoutState requires quantity before email collection', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.checkoutStage = 'product_selected';
  assert.equal(
    resolveTransactionalCheckoutState({ llmState: state }),
    'QUANTITY_COLLECTION_REQUIRED',
  );
});

test('resolveTransactionalCheckoutState enters email collection when cart is ready', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.quantities = { [inStockProduct.variantId]: 1 };
  state.checkoutStage = 'product_selected';
  assert.equal(
    resolveTransactionalCheckoutState({ llmState: state }),
    'EMAIL_COLLECTION_REQUIRED',
  );
});

test('routeTransactionalCheckoutTurn forces spell-slowly email prompt', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.quantities = { [inStockProduct.variantId]: 2 };
  state.checkoutStage = 'product_selected';

  const route = routeTransactionalCheckoutTurn({
    llmState: state,
    userMessage: 'yes I want it',
    emailRetryCount: 0,
  });

  assert.equal(route.handled, true);
  assert.equal(route.skipOpenAiGeneration, true);
  assert.equal(route.deterministicReplyUsed, true);
  assert.equal(route.transactionalState, 'EMAIL_COLLECTION_REQUIRED');
  assert.equal(route.reply, EMAIL_SPELL_COLLECTION_PROMPT);
});

test('routeTransactionalCheckoutTurn asks quantity when missing', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.checkoutStage = 'product_selected';

  const route = routeTransactionalCheckoutTurn({
    llmState: state,
    userMessage: 'yes the first one',
    emailRetryCount: 0,
  });

  assert.equal(route.reply, QUANTITY_PROMPT);
  assert.equal(route.transactionalState, 'QUANTITY_COLLECTION_REQUIRED');
  assert.equal(route.skipOpenAiGeneration, true);
});

test('applyDeterministicProductSelection picks first in-stock search result', () => {
  let state = emptyLlmAgentState();
  state.lastSearchedProducts = [inStockProduct];
  state = applyDeterministicProductSelection(state);
  assert.equal(state.selectedProducts[0]?.variantId, inStockProduct.variantId);
  assert.equal(state.checkoutStage, 'product_selected');
});

test('shouldBypassOpenAiGeneration during checkout email states', () => {
  assert.equal(shouldBypassOpenAiGeneration('EMAIL_COLLECTION_REQUIRED'), true);
  assert.equal(shouldBypassOpenAiGeneration('EMAIL_CONFIRMATION_REQUIRED'), true);
  assert.equal(shouldBypassOpenAiGeneration('INACTIVE'), false);
  assert.equal(shouldBypassOpenAiGeneration('PAYMENT_LINK_SENT'), false);
});

test('containsForbiddenCheckoutPhrase flags generic LLM checkout copy', () => {
  assert.equal(containsForbiddenCheckoutPhrase('Please share your email address.'), true);
  assert.equal(containsForbiddenCheckoutPhrase("I'll prepare the payment link right away."), true);
  assert.equal(containsForbiddenCheckoutPhrase(EMAIL_SPELL_COLLECTION_PROMPT), false);
});

test('guardTransactionalReply replaces forbidden checkout phrases', () => {
  const guarded = guardTransactionalReply('Please share your email address.', {
    transactionalState: 'EMAIL_COLLECTION_REQUIRED',
    emailRetryCount: 0,
  });
  assert.match(guarded, /spell your email address slowly/i);
  assert.doesNotMatch(guarded, /share your email/i);
});

test('isCheckoutCartReady after quantity merge', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state = mergeCallerSignalsIntoState(state, { quantity: 2 });
  assert.equal(isCheckoutCartReady(state), true);
});
