import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationAgent } from '../agents/conversation.agent';
import {
  applyEmailCaptureToSession,
  applyEmailConfirmationToSession,
  applyProductSelectionToSession,
  applySearchResultsToSession,
  canCreatePaymentLink,
  isCheckoutInterrupt,
  isResendPaymentEmailRequest,
  resolveProductSelection,
} from '../checkout/voice-checkout-flow.util';
import { emptyCheckoutSession } from '../checkout/voice-checkout-session.types';
import type { VoiceGraphState } from '../types/voice-turn.types';

const products = [
  { id: 'p1', variantId: 'v1', title: 'Atomic Habits', price: '$18', inStock: true },
  { id: 'p2', variantId: 'v2', title: 'Deep Work', price: '$16', inStock: true },
  { id: 'p3', variantId: 'v3', title: 'Old Book', price: '$10', inStock: false },
];

function baseState(partial: Partial<VoiceGraphState> = {}): VoiceGraphState {
  return {
    callSessionId: 'sess_test',
    utterance: '',
    history: [],
    context: {
      callSessionId: 'sess_test',
      tenantId: 'tenant',
      storeId: 'store',
      agentId: 'agent',
      agent: {
        name: 'Books',
        language: 'en',
        baseSystemPrompt: 'You are a bookstore agent.',
      },
      store: { name: 'Test Books' },
    },
    intent: 'product_search',
    intentConfidence: 0.9,
    immediateFiller: '',
    agentResults: [],
    reply: '',
    modelUsed: 'test',
    escalateToComplexModel: false,
    memoryPatch: {},
    checkoutSession: emptyCheckoutSession(),
    ...partial,
  };
}

test('one product found auto-selects and moves to awaiting email', () => {
  let session = applySearchResultsToSession(emptyCheckoutSession(), [products[0]!]);
  assert.equal(session.stage, 'awaiting_email');
  assert.equal(session.selected?.title, 'Atomic Habits');
});

test('multiple products found enters selection stage', () => {
  const session = applySearchResultsToSession(emptyCheckoutSession(), products.slice(0, 2));
  assert.equal(session.stage, 'awaiting_product_selection');
  assert.equal(session.candidates.length, 2);
});

test('product selection resolves second option', () => {
  let session = applySearchResultsToSession(emptyCheckoutSession(), products.slice(0, 2));
  session = applyProductSelectionToSession(session, 'the second one');
  assert.equal(session.selected?.title, 'Deep Work');
  assert.equal(session.stage, 'awaiting_email');
});

test('ISBN exact match single product path', () => {
  const session = applySearchResultsToSession(emptyCheckoutSession(), [products[0]!]);
  assert.equal(session.candidates.length, 1);
  const ready = {
    ...session,
    confirmedEmail: 'buyer@test.com',
    emailConfirmationState: 'confirmed' as const,
  };
  assert.equal(canCreatePaymentLink(ready), true);
});

test('out of stock product blocks checkout', () => {
  const session = applySearchResultsToSession(emptyCheckoutSession(), [products[2]!]);
  assert.equal(session.stage, 'out_of_stock');
  assert.equal(canCreatePaymentLink({ ...session, confirmedEmail: 'a@b.com', emailConfirmationState: 'confirmed' }), false);
});

test('invalid email stays in awaiting email flow', () => {
  const agent = new ConversationAgent();
  const state = baseState({
    intent: 'email_capture',
    agentResults: [{ agent: 'email_verification', ok: false, error: 'invalid_email', latencyMs: 1 }],
  });
  const { reply } = agent.synthesize(state);
  assert.match(reply!, /valid email/i);
});

test('corrected email prompts spellback confirmation', () => {
  const agent = new ConversationAgent();
  const state = baseState({
    intent: 'email_capture',
    agentResults: [
      {
        agent: 'email_verification',
        ok: true,
        latencyMs: 1,
        data: {
          valid: true,
          normalized: 'user@gmail.com',
          corrected: true,
          spellback: 'user at gmail dot com',
        },
      },
    ],
  });
  const { reply } = agent.synthesize(state);
  assert.match(reply!, /corrected/i);
  assert.match(reply!, /user@gmail.com/i);
});

test('email confirmation yes triggers payment copy', () => {
  let session = applySearchResultsToSession(emptyCheckoutSession(), [products[0]!]);
  session = applyEmailCaptureToSession(session, 'buyer@test.com');
  session = applyEmailConfirmationToSession(session, 'yes that is correct');
  assert.equal(session.confirmedEmail, 'buyer@test.com');
  assert.ok(canCreatePaymentLink(session));

  const agent = new ConversationAgent();
  const { reply } = agent.synthesize(
    baseState({
      intent: 'email_capture',
      utterance: 'yes that is correct',
      checkoutSession: session,
      agentResults: [
        { agent: 'email_verification', ok: true, latencyMs: 1, data: { confirmed: true, normalized: 'buyer@test.com' } },
      ],
    }),
  );
  assert.match(reply!, /payment link/i);
});

test('payment link generated and email sent copy', () => {
  const agent = new ConversationAgent();
  const { reply } = agent.synthesize(
    baseState({
      intent: 'checkout',
      checkoutSession: {
        ...emptyCheckoutSession(),
        stage: 'payment_pending',
        selected: products[0],
        confirmedEmail: 'buyer@test.com',
        paymentLinkSent: true,
      },
      agentResults: [
        {
          agent: 'payment_link',
          ok: true,
          latencyMs: 120,
          data: { checkoutUrl: 'https://shop.test/checkout', sent: true, checkoutLinkId: 'link1' },
        },
      ],
    }),
  );
  assert.match(reply!, /sent a secure checkout link/i);
});

test('shopify checkout failure offers retry', () => {
  const agent = new ConversationAgent();
  const { reply } = agent.synthesize(
    baseState({
      intent: 'checkout',
      agentResults: [
        { agent: 'payment_link', ok: false, error: 'checkout_failed', latencyMs: 800, data: { retryExhausted: true } },
      ],
    }),
  );
  assert.match(reply!, /trouble/i);
});

test('payment pending status messaging', () => {
  const agent = new ConversationAgent();
  const { reply } = agent.synthesize(
    baseState({
      intent: 'unknown',
      checkoutSession: {
        ...emptyCheckoutSession(),
        stage: 'payment_pending',
        paymentLinkSent: true,
        paymentStatus: 'pending',
      },
    }),
  );
  assert.match(reply!, /checkout link/i);
});

test('payment completed congratulates caller', () => {
  const agent = new ConversationAgent();
  const { reply } = agent.synthesize(
    baseState({
      intent: 'checkout',
      checkoutSession: {
        ...emptyCheckoutSession(),
        stage: 'payment_completed',
        paymentStatus: 'completed',
      },
      agentResults: [
        { agent: 'payment_link', ok: true, latencyMs: 5, data: { paymentStatus: 'completed' } },
      ],
    }),
  );
  assert.match(reply!, /payment went through/i);
});

test('user interrupt during checkout resets gracefully', () => {
  assert.ok(isCheckoutInterrupt('never mind, different book'));
  const agent = new ConversationAgent();
  const { reply } = agent.synthesize(
    baseState({
      utterance: 'never mind',
      intent: 'checkout',
      checkoutSession: {
        ...emptyCheckoutSession(),
        stage: 'awaiting_email',
        selected: products[0],
      },
    }),
  );
  assert.match(reply!, /start fresh/i);
});

test('resend payment email request detected', () => {
  assert.ok(isResendPaymentEmailRequest("I didn't get the email, can you resend?"));
});

test('resolveProductSelection matches title fragment', () => {
  const picked = resolveProductSelection('I want atomic habits', products.slice(0, 2));
  assert.equal(picked?.title, 'Atomic Habits');
});
