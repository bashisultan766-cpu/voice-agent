/**
 * Enterprise voice checkout spec tests (requirements 1–14).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLlmAgentState, mergeCallerSignalsIntoState } from './llm-agent-conversation-state.util';
import {
  buildEmailCollectionPrompt,
  buildEmailConfirmationPrompt,
  buildInvalidEmailRetryPrompt,
  containsInlineEmailConfirmation,
  extractEmailFromSpeech,
  isCallerAskingEmailSpellback,
  isPostPaymentClosingUtterance,
  isPaymentEmailDeliveryConfirmed,
  spellEmailForCaller,
  validateEmailEnterprise,
} from './voice-email-capture.util';
import {
  normalizeSpokenEmail,
  parseDoubleTripleDigits,
} from './spoken-email-normalizer.util';
import {
  canCreatePaymentLink,
  flowStateFromLlm,
} from './enterprise-checkout-state-machine.util';
import {
  detectCustomerLanguage,
  replyInCustomerLanguage,
  setSessionLanguage,
} from './voice-checkout-language.util';
import { shouldTriggerCheckoutAfterEmailConfirmed } from './llm-agent-auto-checkout.util';
import { twimlContainsSay } from '../../integrations/twilio/voice-provider-policy.util';
import { buildInboundGatherMvpTwiML } from '../../integrations/twilio/twiml/gather-mvp.twiml';
import {
  resolveVoiceProviderPolicy,
  assertNoTwilioSayInTwiml,
} from '../../integrations/twilio/voice-provider-policy.util';
import { parseCheckoutQuantityFromSpeech } from './transactional-checkout-state.util';

const inStock = {
  title: 'Test Book',
  variantId: 'gid://shopify/ProductVariant/1',
  inStock: true,
  stock: 5,
};

test('1: first email request is normal, not letter-by-letter', () => {
  const prompt = buildEmailCollectionPrompt(0, true);
  assert.match(prompt, /Please tell me your email address/i);
  assert.doesNotMatch(prompt, /letter by letter/i);
});

test('2: first invalid email asks slow repeat', () => {
  assert.match(buildInvalidEmailRetryPrompt(1), /repeat your email address slowly/i);
  assert.doesNotMatch(buildInvalidEmailRetryPrompt(1), /letter by letter/i);
});

test('3: second invalid email asks letter-by-letter', () => {
  assert.match(buildInvalidEmailRetryPrompt(2), /letter by letter/i);
});

test('4: spell captured email for caller', () => {
  const spoken = spellEmailForCaller('bashirsultan766@gmail.com');
  assert.match(spoken, /I captured:/i);
  assert.match(spoken, /seven six six at gmail dot com/i);
  assert.doesNotMatch(spoken, /g m a i l/i);
  assert.equal(isCallerAskingEmailSpellback('repeat what email you captured letter by letter'), true);
});

test('5: inline confirmation skips separate confirm step', () => {
  assert.equal(
    containsInlineEmailConfirmation('bashirsultan766@gmail.com this is correct'),
    true,
  );
});

test('6: payment link only after confirmed email', () => {
  let state = emptyLlmAgentState();
  state.selectedProducts = [inStock];
  state = mergeCallerSignalsIntoState(state, { quantity: 2 });
  state = mergeCallerSignalsIntoState(state, { email: 'buyer@example.com' });
  const unconfirmed = flowStateFromLlm(state, {
    emailConfirmationState: 'pending',
    emailEnterpriseValidated: true,
  });
  assert.equal(canCreatePaymentLink(unconfirmed), false);
  const confirmed = flowStateFromLlm(state, { emailConfirmationState: 'confirmed' });
  assert.equal(canCreatePaymentLink(confirmed), true);
  assert.equal(
    shouldTriggerCheckoutAfterEmailConfirmed(state, { emailConfirmedThisTurn: false }),
    false,
  );
  assert.equal(
    shouldTriggerCheckoutAfterEmailConfirmed(state, { emailConfirmedThisTurn: true }),
    true,
  );
});

test('7: payment success only when delivery confirmed', () => {
  assert.equal(
    isPaymentEmailDeliveryConfirmed({
      success: true,
      providerSuccess: true,
      smtpAccepted: true,
      deliveryQueued: false,
    }),
    true,
  );
  assert.equal(
    isPaymentEmailDeliveryConfirmed({
      success: true,
      providerSuccess: false,
      smtpAccepted: true,
      deliveryQueued: false,
    }),
    false,
  );
});

test('8: post-payment thank you does not restart checkout', () => {
  assert.equal(isPostPaymentClosingUtterance('thank you'), true);
  assert.equal(isPostPaymentClosingUtterance('bashir at gmail dot com'), false);
});

test('9: ElevenLabs-only TwiML has no Twilio Say', () => {
  const policy = resolveVoiceProviderPolicy({
    FORCE_ELEVENLABS_ONLY: 'true',
    STRICT_ELEVENLABS_ONLY: 'true',
    FORCE_TWILIO_FALLBACK: 'false',
  });
  const twiml = buildInboundGatherMvpTwiML({
    gatherActionUrl: 'https://example.com/gather',
    openingSayText: 'Hello',
    finalFallbackSayText: 'Goodbye',
    blockTwilioSay: policy.twilioSayBlocked,
  });
  assert.equal(twimlContainsSay(twiml), false);
  assertNoTwilioSayInTwiml(twiml, policy);
});

test('10: greeting language detection', () => {
  assert.equal(detectCustomerLanguage('As-salamu alaikum').customerLanguage, 'ur');
  assert.equal(detectCustomerLanguage('Namaste').customerLanguage, 'hi');
  assert.equal(detectCustomerLanguage('Hola').customerLanguage, 'es');
  assert.equal(detectCustomerLanguage('Privet').customerLanguage, 'ru');
  assert.equal(detectCustomerLanguage('Hello').customerLanguage, 'en');
});

test('11: same language replies for email request', () => {
  const ur = replyInCustomerLanguage('ur', 'email_first_request');
  assert.match(ur, /ای میل/);
  const es = replyInCustomerLanguage('es', 'email_first_request');
  assert.match(es, /correo electrónico/i);
});

test('12: mixed Urdu-English detection', () => {
  const mixed = detectCustomerLanguage('Salam ji I need this book email bhej do');
  assert.equal(mixed.customerLanguage, 'ur-en');
});

test('13: quantity 1–4 copies parsing', () => {
  assert.equal(parseCheckoutQuantityFromSpeech('two copies'), 2);
  assert.equal(parseCheckoutQuantityFromSpeech('three copies'), 3);
  assert.equal(parseCheckoutQuantityFromSpeech('four copies'), 4);
  assert.equal(parseCheckoutQuantityFromSpeech('just one copy'), 1);
});

test('14: spoken email normalization — double six and seven double six', () => {
  assert.equal(
    normalizeSpokenEmail('bashir sultan seven double six at gmail dot com'),
    'bashirsultan766@gmail.com',
  );
  assert.equal(parseDoubleTripleDigits('seven double six'), '766');
  assert.equal(
    extractEmailFromSpeech('bashir sultan seven double six at gmail dot com'),
    'bashirsultan766@gmail.com',
  );
});

test('enterprise email validation returns spec shape', () => {
  const r = validateEmailEnterprise('user at gmial dot com');
  assert.equal(r.valid, false);
  assert.ok(r.suggestedCorrection?.includes('gmail.com') || !r.regexValid);
});

test('confirmation prompt uses TTS-friendly spoken form', () => {
  const p = buildEmailConfirmationPrompt('bashirsultan766@gmail.com');
  assert.match(p, /I have your email as/i);
  assert.match(p, /seven six six at gmail dot com/i);
});

test('language sticks until high-confidence switch', () => {
  assert.equal(setSessionLanguage('en', 'es', 0.5), 'en');
  assert.equal(setSessionLanguage('en', 'es', 0.95), 'es');
});

test('different callers can use different emails', () => {
  const a = extractEmailFromSpeech('alice one at gmail dot com');
  const b = extractEmailFromSpeech('bob two at gmail dot com');
  assert.notEqual(a, b);
  assert.equal(a, 'alice1@gmail.com');
  assert.equal(b, 'bob2@gmail.com');
});
