import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPaymentFlowToState,
  buildConfirmedEmailCheckoutReply,
  buildCreatePaymentLinkArgsFromState,
  shouldTriggerCheckoutAfterEmailConfirmed,
} from './llm-agent-auto-checkout.util';
import { emptyLlmAgentState, mergeCallerSignalsIntoState } from './llm-agent-conversation-state.util';
import { MAX_EMAIL_SEND_RETRIES } from './voice-email-capture.util';

const inStockProduct = {
  title: 'World History Vol 1',
  variantId: 'gid://shopify/ProductVariant/99',
  inStock: true,
  stock: 8,
};

test('shouldTriggerCheckoutAfterEmailConfirmed when email confirmed with product and quantity', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state = mergeCallerSignalsIntoState(state, { quantity: 2 });
  state = mergeCallerSignalsIntoState(state, { email: 'buyer@example.com' });
  assert.equal(
    shouldTriggerCheckoutAfterEmailConfirmed(state, { emailConfirmedThisTurn: true }),
    true,
  );
});

test('shouldTriggerCheckoutAfterEmailConfirmed does not run on capture alone', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state = mergeCallerSignalsIntoState(state, { email: 'buyer@example.com' });
  assert.equal(
    shouldTriggerCheckoutAfterEmailConfirmed(state, { emailConfirmedThisTurn: false }),
    false,
  );
});

test('shouldTriggerCheckoutAfterEmailConfirmed rejects invalid email', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.customerEmail = 'not-an-email';
  state.checkoutStage = 'email';
  assert.equal(
    shouldTriggerCheckoutAfterEmailConfirmed(state, { emailConfirmedThisTurn: true }),
    false,
  );
});

test('shouldTriggerCheckoutAfterEmailConfirmed does not run when payment already sent', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.paymentLinkSent = true;
  state.customerEmail = 'buyer@example.com';
  state.checkoutStage = 'email';
  assert.equal(
    shouldTriggerCheckoutAfterEmailConfirmed(state, { emailConfirmedThisTurn: true }),
    false,
  );
});

test('buildCreatePaymentLinkArgsFromState includes variant and quantity', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.customerEmail = 'buyer@example.com';
  state.quantities = { [inStockProduct.variantId]: 2 };
  state.checkoutStage = 'email';
  const args = buildCreatePaymentLinkArgsFromState(state);
  assert.ok(args);
  assert.equal(args!.email, 'buyer@example.com');
  assert.equal(args!.items[0]!.variantId, inStockProduct.variantId);
  assert.equal(args!.items[0]!.quantity, 2);
});

test('buildCreatePaymentLinkArgsFromState returns null for invalid email', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.customerEmail = 'invalid-email';
  assert.equal(buildCreatePaymentLinkArgsFromState(state), null);
});

test('applyPaymentFlowToState marks payment_sent when email delivered', () => {
  const next = applyPaymentFlowToState(emptyLlmAgentState(), {
    paymentLinkCreated: true,
    paymentLinkSent: true,
    checkoutLinkId: 'chk_1',
    checkoutUrl: 'https://store.example/cart',
  });
  assert.equal(next.checkoutStage, 'payment_sent');
  assert.equal(next.paymentLinkSent, true);
});

test('buildConfirmedEmailCheckoutReply on success only when emailApiResult.success', () => {
  const msg = buildConfirmedEmailCheckoutReply({
    email: 'buyer@example.com',
    checkoutOk: true,
    emailOk: true,
    emailApiResult: {
      success: true,
      smtpAccepted: true,
      providerSuccess: true,
      deliveryQueued: true,
    },
    checkoutUrl: 'https://store.example/cart',
  });
  assert.match(msg, /sent successfully/i);
  assert.match(msg, /check your inbox/i);
  assert.doesNotMatch(msg, /issue sending/i);
});

test('buildConfirmedEmailCheckoutReply does not claim success without emailApiResult', () => {
  const msg = buildConfirmedEmailCheckoutReply({
    email: 'buyer@example.com',
    checkoutOk: true,
    emailOk: false,
    emailApiResult: {
      success: false,
      smtpAccepted: false,
      providerSuccess: false,
      deliveryQueued: false,
    },
    checkoutUrl: 'https://store.example/cart',
  });
  assert.doesNotMatch(msg, /sent successfully/i);
});

test('buildConfirmedEmailCheckoutReply on email failure does not claim delivery', () => {
  const msg = buildConfirmedEmailCheckoutReply({
    email: 'buyer@example.com',
    checkoutOk: true,
    emailOk: false,
    checkoutUrl: 'https://store.example/cart',
    emailSendFailureCount: 1,
  });
  assert.match(msg, /issue sending the payment link/i);
  assert.doesNotMatch(msg, /sent successfully/i);
});

test('buildConfirmedEmailCheckoutReply offers fallback after max send failures', () => {
  const msg = buildConfirmedEmailCheckoutReply({
    email: 'buyer@example.com',
    checkoutOk: true,
    emailOk: false,
    emailSendFailureCount: MAX_EMAIL_SEND_RETRIES,
  });
  assert.match(msg, /WhatsApp or SMS/i);
});
