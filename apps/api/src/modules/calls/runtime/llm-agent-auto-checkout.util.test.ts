import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPaymentFlowToState,
  buildAutoCheckoutConfirmationReply,
  buildCreatePaymentLinkArgsFromState,
  shouldAutoTriggerCheckoutAfterEmail,
} from './llm-agent-auto-checkout.util';
import { emptyLlmAgentState, mergeCallerSignalsIntoState } from './llm-agent-conversation-state.util';

const inStockProduct = {
  title: 'World History Vol 1',
  variantId: 'gid://shopify/ProductVariant/99',
  inStock: true,
  stock: 8,
};

test('shouldAutoTriggerCheckoutAfterEmail when email confirmed with product and quantity', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state = mergeCallerSignalsIntoState(state, { quantity: 2 });
  state = mergeCallerSignalsIntoState(state, { email: 'buyer@example.com' });
  assert.equal(
    shouldAutoTriggerCheckoutAfterEmail(state, { emailConfirmedThisTurn: true }),
    true,
  );
});

test('shouldAutoTriggerCheckoutAfterEmail does not run on capture alone', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state = mergeCallerSignalsIntoState(state, { email: 'buyer@example.com' });
  assert.equal(
    shouldAutoTriggerCheckoutAfterEmail(state, { emailConfirmedThisTurn: false }),
    false,
  );
});

test('shouldAutoTriggerCheckoutAfterEmail does not run when payment already sent', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.paymentLinkSent = true;
  state.customerEmail = 'buyer@example.com';
  state.checkoutStage = 'email';
  assert.equal(
    shouldAutoTriggerCheckoutAfterEmail(state, { emailConfirmedThisTurn: true }),
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

test('buildAutoCheckoutConfirmationReply on email failure asks to retry send', () => {
  const msg = buildAutoCheckoutConfirmationReply({
    email: 'buyer@example.com',
    checkoutOk: true,
    emailOk: false,
    checkoutUrl: 'https://store.example/cart',
  });
  assert.match(msg, /issue sending the payment link/i);
  assert.doesNotMatch(msg, /sent the secure payment link/i);
});
