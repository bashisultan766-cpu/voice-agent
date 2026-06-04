import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyPaymentFlowToState,
  shouldTriggerCheckoutAfterEmailConfirmed,
} from './llm-agent-auto-checkout.util';
import { emptyLlmAgentState, type LlmAgentConversationState } from './llm-agent-conversation-state.util';
import {
  allPaymentRecipientsTerminal,
  markRecipientPaymentSent,
  parsePaymentRecipients,
} from './payment-recipient.util';

function baseState(): LlmAgentConversationState {
  return {
    ...emptyLlmAgentState(),
    selectedProducts: [
      {
        title: 'Capital Seven',
        productId: 'gid://shopify/Product/1',
        variantId: 'gid://shopify/ProductVariant/1',
        inStock: true,
      },
    ],
    quantities: { 'gid://shopify/ProductVariant/1': 1 },
    customerEmail: 'john@gmail.com',
    checkoutStage: 'email',
  };
}

test('shouldTriggerCheckoutAfterEmailConfirmed allows second book after first link sent', () => {
  const firstBookSent = markRecipientPaymentSent(
    [],
    'gid://shopify/Product/1',
    'john@gmail.com',
    {
      paymentLink: 'https://pay/1',
      productTitle: 'Capital Seven',
      variantId: 'gid://shopify/ProductVariant/1',
    },
  );
  const state: LlmAgentConversationState = {
    ...baseState(),
    paymentLinkSent: true,
    paymentLinkCreated: true,
    paymentRecipients: firstBookSent,
    selectedProducts: [
      {
        title: 'Illuminati',
        productId: 'gid://shopify/Product/2',
        variantId: 'gid://shopify/ProductVariant/2',
        inStock: true,
      },
    ],
    quantities: { 'gid://shopify/ProductVariant/2': 1 },
    customerEmail: 'jessica@gmail.com',
  };
  assert.equal(
    shouldTriggerCheckoutAfterEmailConfirmed(state, { emailConfirmedThisTurn: true }),
    true,
  );
});

test('shouldTriggerCheckoutAfterEmailConfirmed blocks duplicate product email', () => {
  const recipients = markRecipientPaymentSent(
    [],
    'gid://shopify/Product/1',
    'john@gmail.com',
    { paymentLink: 'https://pay/1' },
  );
  const state: LlmAgentConversationState = {
    ...baseState(),
    paymentRecipients: recipients,
    paymentLinkSent: true,
  };
  assert.equal(
    shouldTriggerCheckoutAfterEmailConfirmed(state, { emailConfirmedThisTurn: true }),
    false,
  );
});

test('applyPaymentFlowToState records paymentRecipients', () => {
  const next = applyPaymentFlowToState(baseState(), {
    paymentLinkCreated: true,
    paymentLinkSent: true,
    checkoutUrl: 'https://checkout.example',
    checkoutLinkId: 'cl-1',
    draftOrderId: 'draft-1',
  });
  assert.equal(parsePaymentRecipients(next.paymentRecipients).length, 1);
  assert.equal(next.paymentRecipients?.[0]?.paymentStatus, 'link_sent');
});

test('allPaymentRecipientsTerminal requires every recipient settled', () => {
  const rows = parsePaymentRecipients([
    {
      productId: 'p1',
      productTitle: 'A',
      recipientEmail: 'a@b.com',
      paymentStatus: 'link_sent',
    },
    {
      productId: 'p2',
      productTitle: 'B',
      recipientEmail: 'c@d.com',
      paymentStatus: 'email_confirmed',
    },
  ]);
  assert.equal(allPaymentRecipientsTerminal(rows), false);
});
