import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLlmAgentState, mergeCallerSignalsIntoState } from './llm-agent-conversation-state.util';
import { EMAIL_SPELL_COLLECTION_PROMPT } from './voice-email-capture.util';
import { QUANTITY_PROMPT } from './book-sales-voice.util';
import {
  applyCheckoutSignalsFromSpeech,
  applyDeterministicProductSelection,
  assertNoOpenAiDuringTransactionalCheckout,
  containsForbiddenCheckoutPhrase,
  emergencyBlockLlmCheckoutReply,
  evaluateCheckoutLock,
  guardTransactionalReply,
  isCheckoutCartReady,
  parseCheckoutQuantityFromSpeech,
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
    'PRODUCT_CONFIRMED',
  );
});

test('resolveTransactionalCheckoutState product confirmed before email when cart ready', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.quantities = { [inStockProduct.variantId]: 1 };
  state.checkoutStage = 'product_selected';
  assert.equal(
    resolveTransactionalCheckoutState({ llmState: state, productCheckoutIntroduced: false }),
    'PRODUCT_CONFIRMED',
  );
});

test('resolveTransactionalCheckoutState enters email collection when cart is ready', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.quantities = { [inStockProduct.variantId]: 1 };
  state.checkoutStage = 'product_selected';
  state.checkoutProductAcknowledged = true;
  assert.equal(
    resolveTransactionalCheckoutState({
      llmState: state,
      productCheckoutIntroduced: true,
    }),
    'EMAIL_COLLECTION_REQUIRED',
  );
});

test('resolveTransactionalCheckoutState enters email collection when cart is ready in product_discovery', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.quantities = { [inStockProduct.variantId]: 1 };
  state.checkoutStage = 'product_discovery';
  state.customerIntent = 'product_search';
  state.checkoutProductAcknowledged = true;
  assert.equal(
    resolveTransactionalCheckoutState({
      llmState: state,
      productCheckoutIntroduced: true,
    }),
    'EMAIL_COLLECTION_REQUIRED',
  );
});

test('parseCheckoutQuantityFromSpeech handles one copy phrasing', () => {
  assert.equal(parseCheckoutQuantityFromSpeech('yeah just one copy for this'), 1);
  assert.equal(parseCheckoutQuantityFromSpeech('2 copies please'), 2);
});

test('evaluateCheckoutLock product confirmation before email collection', () => {
  let state = emptyLlmAgentState();
  state.lastSearchedProducts = [inStockProduct];
  state = applyCheckoutSignalsFromSpeech(state, 'yeah just one copy for this');
  const lock = evaluateCheckoutLock(state, { productCheckoutIntroduced: false });
  assert.equal(lock.checkoutLockActive, true);
  assert.equal(lock.checkoutState, 'PRODUCT_CONFIRMED');
  assert.equal(lock.skipOpenAiGeneration, true);
  assert.match(lock.reply ?? '', /help you place the order/i);
});

test('evaluateCheckoutLock email collection after product introduced', () => {
  let state = emptyLlmAgentState();
  state.lastSearchedProducts = [inStockProduct];
  state = applyCheckoutSignalsFromSpeech(state, 'yeah just one copy for this');
  const lock = evaluateCheckoutLock(state, { productCheckoutIntroduced: true });
  assert.equal(lock.checkoutLockActive, true);
  assert.equal(lock.checkoutState, 'EMAIL_COLLECTION_REQUIRED');
  assert.match(lock.reply ?? '', /spell your email address slowly/i);
});

test('assertNoOpenAiDuringTransactionalCheckout throws when OpenAI used', () => {
  assert.throws(
    () =>
      assertNoOpenAiDuringTransactionalCheckout({
        transactionalCheckoutMode: true,
        openaiCalled: true,
      }),
    /CRITICAL: OpenAI used during checkout flow/,
  );
});

test('emergencyBlockLlmCheckoutReply replaces LLM checkout phrasing', () => {
  const blocked = emergencyBlockLlmCheckoutReply('Please share your email address.', {
    activeProductSelected: true,
    openaiCalled: true,
  });
  assert.match(blocked, /spell your email address slowly/i);
});

test('routeTransactionalCheckoutTurn product confirmation before email', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.quantities = { [inStockProduct.variantId]: 2 };
  state.checkoutStage = 'product_selected';

  const route = routeTransactionalCheckoutTurn({
    llmState: state,
    userMessage: 'yes I want it',
    emailRetryCount: 0,
    productCheckoutIntroduced: false,
  });

  assert.equal(route.handled, true);
  assert.equal(route.transactionalState, 'PRODUCT_CONFIRMED');
  assert.match(route.reply ?? '', /help you place the order/i);
});

test('routeTransactionalCheckoutTurn forces spell-slowly email prompt', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.quantities = { [inStockProduct.variantId]: 2 };
  state.checkoutStage = 'product_selected';
  state.checkoutProductAcknowledged = true;

  const route = routeTransactionalCheckoutTurn({
    llmState: state,
    userMessage: 'ok',
    emailRetryCount: 0,
    productCheckoutIntroduced: true,
  });

  assert.equal(route.handled, true);
  assert.equal(route.transactionalState, 'EMAIL_COLLECTION_REQUIRED');
  assert.match(route.reply ?? '', /spell your email address slowly/i);
});

test('routeTransactionalCheckoutTurn product intro then quantity when missing', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.checkoutStage = 'product_selected';

  const intro = routeTransactionalCheckoutTurn({
    llmState: state,
    userMessage: 'I want that book',
    emailRetryCount: 0,
    productCheckoutIntroduced: false,
  });
  assert.match(intro.reply ?? '', /help you place the order/i);
  assert.equal(intro.transactionalState, 'PRODUCT_CONFIRMED');

  state.checkoutProductAcknowledged = true;
  assert.equal(
    resolveTransactionalCheckoutState({
      llmState: state,
      productCheckoutIntroduced: true,
    }),
    'QUANTITY_COLLECTION_REQUIRED',
  );
  const route = routeTransactionalCheckoutTurn({
    llmState: state,
    userMessage: 'ok',
    emailRetryCount: 0,
    productCheckoutIntroduced: true,
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
  assert.equal(shouldBypassOpenAiGeneration('PAYMENT_LINK_SENT'), true);
  assert.equal(shouldBypassOpenAiGeneration('INACTIVE'), false);
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
