/**
 * Production integration tests for enterprise voice checkout — deterministic flow,
 * email validation, delivery gates, retries, and hallucination prevention.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLlmAgentState, mergeCallerSignalsIntoState } from './llm-agent-conversation-state.util';
import { buildAutoCheckoutConfirmationReply } from './llm-agent-auto-checkout.util';
import {
  buildEmailConfirmationPrompt,
  buildEmailCollectionPrompt,
  buildCheckoutProductConfirmedPrompt,
  buildPaymentEmailSendFailurePrompt,
  containsPaymentSuccessClaim,
  extractEmailFromSpeech,
  isEmailConfirmationAffirmative,
  isPaymentEmailDeliveryConfirmed,
  sanitizePaymentSuccessClaim,
  validateVoiceEmail,
  MAX_EMAIL_SEND_RETRIES,
} from './voice-email-capture.util';
import {
  validateEnterpriseEmail,
  validateEnterpriseEmailSync,
} from './voice-email-enterprise-validation.util';
import {
  evaluateCheckoutLock,
  guardTransactionalReply,
  resolveTransactionalCheckoutState,
  routeTransactionalCheckoutTurn,
} from './transactional-checkout-state.util';

const inStockProduct = {
  title: 'World History Vol 1',
  variantId: 'gid://shopify/ProductVariant/99',
  inStock: true,
  stock: 8,
};

test('voice email capture: spoken shahbazsultan88 at gmail dot com', () => {
  const raw = extractEmailFromSpeech('shahbazsultan88 at gmail dot com');
  assert.equal(raw, 'shahbazsultan88@gmail.com');
  const validation = validateVoiceEmail(raw!);
  assert.equal(validation.valid, true);
  assert.equal(validation.normalized, 'shahbazsultan88@gmail.com');
});

test('voice email capture: short short 94 at gmail dot com normalizes without checkout', () => {
  const raw = extractEmailFromSpeech('short short 94 at gmail dot com');
  assert.equal(raw, 'shortshort94@gmail.com');
  const validation = validateVoiceEmail(raw!);
  assert.equal(validation.normalized, 'shortshort94@gmail.com');
  const prompt = buildEmailConfirmationPrompt(validation.normalized);
  assert.match(prompt, /shortshort94 at gmail dot com/i);
  assert.match(prompt, /Is that correct/);
  assert.equal(isEmailConfirmationAffirmative('short short 94 at gmail dot com'), false);
});

test('voice email capture: confirmation prompt waits for explicit yes', () => {
  const prompt = buildEmailConfirmationPrompt('shahbazsultan88@gmail.com');
  assert.match(prompt, /Just to confirm, your email is shahbazsultan88 at gmail dot com/i);
  assert.match(prompt, /Is that correct/);
  assert.equal(isEmailConfirmationAffirmative('yes that is correct'), true);
  assert.equal(isEmailConfirmationAffirmative('maybe'), false);
});

test('enterprise validation: gmial typo then correction path', async () => {
  const bad = validateEnterpriseEmailSync('user at gmial dot com');
  assert.equal(bad.valid, false);
  assert.ok(bad.typoSuggestion);
  const fixed = await validateEnterpriseEmail(bad.typoSuggestion!.correctedEmail, {
    skipMx: true,
  });
  assert.equal(fixed.valid, true);
});

test('checkout state machine: cart ready goes to EMAIL_COLLECTION_REQUIRED', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.quantities = { [inStockProduct.variantId]: 1 };

  assert.equal(
    resolveTransactionalCheckoutState({ llmState: state, productCheckoutIntroduced: false }),
    'EMAIL_COLLECTION_REQUIRED',
  );
});

test('checkout lock: spell-slowly email when cart is ready', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state = mergeCallerSignalsIntoState(state, { quantity: 1 });

  const lock = evaluateCheckoutLock(state, { productCheckoutIntroduced: false });
  assert.match(lock.reply ?? '', /help you place the order/i);
  assert.match(lock.reply ?? '', /spell your email address slowly/i);
});

test('transactional route: spell-slowly email when cart is ready', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStockProduct];
  state.quantities = { [inStockProduct.variantId]: 1 };

  const route = routeTransactionalCheckoutTurn({
    llmState: state,
    userMessage: 'yes',
    emailRetryCount: 0,
    productCheckoutIntroduced: false,
  });
  assert.match(route.reply ?? '', /spell your email address slowly/i);
  assert.equal(route.deterministicReplyUsed, true);
  assert.equal(route.skipOpenAiGeneration, true);
});

test('email collection uses required spell-slowly copy', () => {
  assert.match(buildEmailCollectionPrompt(0, true), /spell your email address slowly/i);
});

test('delivery gate: success only when provider accepted delivery', () => {
  assert.equal(
    isPaymentEmailDeliveryConfirmed({
      success: true,
      smtpAccepted: true,
      providerSuccess: true,
      deliveryQueued: true,
    }),
    true,
  );
  assert.equal(
    isPaymentEmailDeliveryConfirmed({
      success: false,
      smtpAccepted: false,
      providerSuccess: false,
      deliveryQueued: false,
    }),
    false,
  );
  assert.equal(isPaymentEmailDeliveryConfirmed(undefined), false);
});

test('auto checkout reply: never claims sent without provider success', () => {
  const failed = buildAutoCheckoutConfirmationReply({
    email: 'buyer@example.com',
    checkoutOk: true,
    emailOk: false,
    emailApiResult: {
      success: false,
      smtpAccepted: false,
      providerSuccess: false,
      deliveryQueued: false,
    },
  });
  assert.doesNotMatch(failed, /sent successfully/i);
  assert.match(failed, /issue sending the payment link/i);
});

test('auto checkout reply: success copy only with emailApiResult.success', () => {
  const ok = buildAutoCheckoutConfirmationReply({
    email: 'buyer@example.com',
    checkoutOk: true,
    emailOk: true,
    emailApiResult: {
      success: true,
      smtpAccepted: true,
      providerSuccess: true,
      deliveryQueued: true,
    },
  });
  assert.match(ok, /sent successfully/i);
});

test('send failure: retry prompt then WhatsApp/SMS fallback', () => {
  assert.match(buildPaymentEmailSendFailurePrompt(1), /issue sending the payment link/i);
  const fallback = buildAutoCheckoutConfirmationReply({
    email: 'buyer@example.com',
    checkoutOk: true,
    emailOk: false,
    emailSendFailureCount: MAX_EMAIL_SEND_RETRIES,
  });
  assert.match(fallback, /WhatsApp or SMS/i);
});

test('hallucination prevention: guard strips false payment-success claims', () => {
  const guarded = guardTransactionalReply(
    'Great news, your payment link has been sent. Check your inbox.',
    {
      transactionalState: 'EMAIL_CONFIRMATION_REQUIRED',
      deliveryConfirmed: false,
      pendingEmail: 'buyer@example.com',
    },
  );
  assert.doesNotMatch(guarded, /payment link has been sent/i);
  assert.match(guarded, /Just to confirm, your email is buyer at example dot com/i);
});

test('sanitizePaymentSuccessClaim replaces LLM hallucination on send failure', () => {
  const sanitized = sanitizePaymentSuccessClaim(
    'I sent the payment link to your email. Check your inbox.',
    false,
  );
  assert.match(sanitized, /issue sending the payment link/i);
  assert.equal(containsPaymentSuccessClaim(sanitized), false);
});
