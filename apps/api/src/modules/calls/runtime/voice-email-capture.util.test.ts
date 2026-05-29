import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmailConfirmationPrompt,
  buildEmailCollectionPrompt,
  buildInvalidEmailRetryPrompt,
  buildPaymentEmailSendFailurePrompt,
  extractEmailFromSpeech,
  isEmailConfirmationAffirmative,
  isEmailConfirmationNegative,
  maskEmailForLog,
  normalizeSpokenEmail,
  validateVoiceEmail,
  VOICE_EMAIL_REGEX,
} from './voice-email-capture.util';

test('normalizeSpokenEmail converts at, dot, spaces, and digit words', () => {
  assert.equal(
    normalizeSpokenEmail('bashi sultan seven six six at gmail dot com'),
    'bashisultan766@gmail.com',
  );
  assert.equal(normalizeSpokenEmail('reader at the rate example dot org'), 'reader@example.org');
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
});

test('extractEmailFromSpeech handles spoken and direct forms', () => {
  assert.equal(extractEmailFromSpeech('my email is reader@example.com'), 'reader@example.com');
  assert.equal(extractEmailFromSpeech('bashi at gmail dot com'), 'bashi@gmail.com');
  assert.equal(extractEmailFromSpeech('just checking stock'), null);
});

test('buildEmailConfirmationPrompt reads email back for confirmation', () => {
  const prompt = buildEmailConfirmationPrompt('example@gmail.com');
  assert.match(prompt, /Just to confirm, your email is example@gmail.com\. Is that correct\?/);
});

test('buildEmailCollectionPrompt escalates politely on retries', () => {
  assert.match(buildEmailCollectionPrompt(0), /spell your email address slowly/i);
  assert.match(buildEmailCollectionPrompt(1), /did not quite catch/i);
  assert.match(buildInvalidEmailRetryPrompt(3), /one final time/i);
});

test('confirmation helpers distinguish yes and no', () => {
  assert.equal(isEmailConfirmationAffirmative('yes that is correct'), true);
  assert.equal(isEmailConfirmationAffirmative('no that is wrong'), false);
  assert.equal(isEmailConfirmationNegative('no please change it'), true);
});

test('payment send failure prompt matches product copy', () => {
  assert.equal(
    buildPaymentEmailSendFailurePrompt(),
    'I apologize, there was an issue sending the payment link. Let me try again.',
  );
});

test('maskEmailForLog redacts local part', () => {
  assert.equal(maskEmailForLog('reader@example.com'), 'r***@example.com');
});
