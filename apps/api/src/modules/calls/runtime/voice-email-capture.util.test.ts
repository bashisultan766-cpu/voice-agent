import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmailConfirmationPrompt,
  buildEmailCollectionPrompt,
  buildEmailProcessingPrompt,
  buildInvalidEmailRetryPrompt,
  containsInlineEmailConfirmation,
  isPostPaymentClosingUtterance,
  buildPaymentEmailFallbackDeliveryPrompt,
  buildPaymentEmailSendFailurePrompt,
  buildPaymentEmailSuccessPrompt,
  buildVoiceEmailCaptureLog,
  containsPaymentSuccessClaim,
  extractEmailFromSpeech,
  isDeterministicTransactionalReply,
  isEmailConfirmationAffirmative,
  isEmailConfirmationNegative,
  maskEmailForLog,
  maskRawSpeechForLog,
  MAX_EMAIL_SEND_RETRIES,
  MAX_VOICE_EMAIL_RETRIES,
  nextEmailRetryCount,
  normalizeSpokenEmail,
  sanitizePaymentSuccessClaim,
  shouldOfferEmailRetry,
  validateVoiceEmail,
  VOICE_EMAIL_REGEX,
} from './voice-email-capture.util';

test('normalizeSpokenEmail converts at, dot, spaces, and digit words', () => {
  assert.equal(
    normalizeSpokenEmail('short short 94 at gmail dot com'),
    'shortshort94@gmail.com',
  );
  assert.equal(
    normalizeSpokenEmail('bashi sultan seven six six at gmail dot com'),
    'bashisultan766@gmail.com',
  );
  assert.equal(normalizeSpokenEmail('reader at the rate example dot org'), 'reader@example.org');
  assert.equal(
    normalizeSpokenEmail('john dot doe at gmail dot com'),
    'john.doe@gmail.com',
  );
  assert.equal(
    normalizeSpokenEmail('shahbazsultan88 at gmail dot com'),
    'shahbazsultan88@gmail.com',
  );
});

test('validateVoiceEmail accepts well-formed addresses', () => {
  const result = validateVoiceEmail('reader at example dot com');
  assert.equal(result.valid, true);
  assert.equal(result.normalized, 'reader@example.com');
  assert.match(result.normalized, VOICE_EMAIL_REGEX);
});

test('validateVoiceEmail rejects incomplete addresses', () => {
  const result = validateVoiceEmail('not an email');
  assert.equal(result.valid, false);
  assert.equal(validateVoiceEmail('missing-at-sign').valid, false);
  assert.equal(validateVoiceEmail('bad@domain').valid, false);
});

test('extractEmailFromSpeech handles spoken and direct forms', () => {
  assert.equal(extractEmailFromSpeech('my email is reader@example.com'), 'reader@example.com');
  assert.equal(extractEmailFromSpeech('bashi at gmail dot com'), 'bashi@gmail.com');
  assert.equal(extractEmailFromSpeech('just checking stock'), null);
});

test('buildEmailConfirmationPrompt reads email back for confirmation', () => {
  const prompt = buildEmailConfirmationPrompt('shahbazsultan88@gmail.com');
  assert.match(prompt, /Just to confirm, I have your email as/i);
  assert.match(prompt, /s h a h b a z/i);
  assert.match(prompt, /g m a i l dot com/i);
  assert.match(prompt, /Is that correct/i);
  assert.doesNotMatch(prompt, /say yes/i);
});

test('buildEmailCollectionPrompt uses professional first request', () => {
  assert.match(buildEmailCollectionPrompt(0), /Please tell me your email address/i);
  assert.doesNotMatch(buildEmailCollectionPrompt(0), /letter by letter/i);
  assert.match(buildEmailCollectionPrompt(0, true), /Perfect\. I'll help you place the order/i);
  assert.match(buildEmailCollectionPrompt(1), /couldn't verify that email/i);
  assert.doesNotMatch(buildEmailCollectionPrompt(1), /letter by letter/i);
  assert.match(buildEmailCollectionPrompt(2), /one character at a time/i);
});

test('buildInvalidEmailRetryPrompt asks caller to repeat slowly', () => {
  assert.match(buildInvalidEmailRetryPrompt(1), /couldn't verify that email/i);
  assert.doesNotMatch(buildInvalidEmailRetryPrompt(1), /b a s h i/i);
  assert.match(buildInvalidEmailRetryPrompt(MAX_VOICE_EMAIL_RETRIES), /letter by letter/i);
});

test('isPostPaymentClosingUtterance recognizes thank-you without restarting checkout', () => {
  assert.equal(isPostPaymentClosingUtterance('thank you'), true);
  assert.equal(isPostPaymentClosingUtterance('okay thanks'), true);
  assert.equal(isPostPaymentClosingUtterance('sureshot924@gmail.com'), false);
});

test('confirmation helpers distinguish yes and no', () => {
  assert.equal(isEmailConfirmationAffirmative('yes that is correct'), true);
  assert.equal(isEmailConfirmationAffirmative('correct'), true);
  assert.equal(isEmailConfirmationAffirmative("that's right"), true);
  assert.equal(isEmailConfirmationAffirmative("yes that's my email"), true);
  assert.equal(isEmailConfirmationAffirmative('no that is wrong'), false);
  assert.equal(
    isEmailConfirmationAffirmative('my address is sur.shop924@gmail.com'),
    false,
  );
  assert.equal(isEmailConfirmationNegative('no please change it'), true);
  assert.equal(
    containsInlineEmailConfirmation("No, it's not correct. user at gmail dot com"),
    false,
  );
});

test('payment send failure and fallback prompts', () => {
  assert.match(buildPaymentEmailSendFailurePrompt(1), /issue sending the payment link/i);
  assert.match(buildPaymentEmailSendFailurePrompt(MAX_EMAIL_SEND_RETRIES), /WhatsApp or SMS/i);
  assert.match(buildPaymentEmailFallbackDeliveryPrompt(), /WhatsApp or SMS/i);
});

test('buildEmailProcessingPrompt and success prompt match product copy', () => {
  assert.match(buildEmailProcessingPrompt(), /preparing your secure payment link/i);
  assert.match(buildPaymentEmailSuccessPrompt(), /sent successfully.*check your inbox/i);
});

test('maskEmailForLog and maskRawSpeechForLog redact PII', () => {
  assert.equal(maskEmailForLog('reader@example.com'), 'r***@example.com');
  const masked = maskRawSpeechForLog('my email is reader@example.com please');
  assert.match(masked, /r\*\*\*@example\.com/);
  assert.doesNotMatch(masked, /reader@example\.com/);
});

test('retry helpers enforce max attempts', () => {
  assert.equal(nextEmailRetryCount(0, false), 1);
  assert.equal(nextEmailRetryCount(2, false), 3);
  assert.equal(nextEmailRetryCount(2, true), 2);
  assert.equal(shouldOfferEmailRetry(MAX_VOICE_EMAIL_RETRIES - 1), true);
  assert.equal(shouldOfferEmailRetry(MAX_VOICE_EMAIL_RETRIES), false);
});

test('buildVoiceEmailCaptureLog includes structured fields', () => {
  const log = buildVoiceEmailCaptureLog({
    event: 'voice.email.send_status',
    callSessionId: 'sess_1',
    maskedEmail: 'b***@example.com',
    sendOk: true,
    confirmationStatus: 'confirmed',
    sendFailureCount: 0,
  });
  assert.equal(log.event, 'voice.email.send_status');
  assert.equal(log.sendOk, true);
  assert.equal(log.confirmationStatus, 'confirmed');
});

test('containsPaymentSuccessClaim detects hallucinated delivery phrases', () => {
  assert.equal(containsPaymentSuccessClaim('Your payment link has been sent successfully.'), true);
  assert.equal(containsPaymentSuccessClaim('I sent the payment link to your email.'), true);
  assert.equal(containsPaymentSuccessClaim('Please spell your email slowly.'), false);
});

test('sanitizePaymentSuccessClaim strips false success claims', () => {
  const sanitized = sanitizePaymentSuccessClaim(
    'Great, I sent the payment link. Check your inbox.',
    false,
  );
  assert.match(sanitized, /issue sending the payment link/i);
  assert.doesNotMatch(sanitized, /sent the payment link/i);
});

test('sanitizePaymentSuccessClaim preserves text when delivery confirmed', () => {
  const original = 'Your payment link has been sent successfully. Please check your inbox.';
  assert.equal(sanitizePaymentSuccessClaim(original, true), original);
});

test('sanitizePaymentSuccessClaim replaces LLM email readback with inbox prompt', () => {
  const llm = "I've sent the secure payment link to sur. shop924@gmail. com.";
  assert.equal(
    sanitizePaymentSuccessClaim(llm, true),
    buildPaymentEmailSuccessPrompt(),
  );
});

test('isDeterministicTransactionalReply protects checkout copy from rewrite', () => {
  assert.equal(
    isDeterministicTransactionalReply(
      'Just to confirm, your email is buyer@example.com. Is that correct?',
    ),
    true,
  );
  assert.equal(
    isDeterministicTransactionalReply('Your payment link has been sent successfully.'),
    true,
  );
  assert.equal(isDeterministicTransactionalReply('What book are you looking for?'), false);
});
