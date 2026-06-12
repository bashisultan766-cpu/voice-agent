import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureEmailFromVoice,
  containsInlineEmailConfirmation,
  expandPhoneticSpelling,
  isEmailCaptureConfidenceSufficient,
  isEmailConfirmationNegative,
  isCallerAskingEmailSpellback,
  normalizeSpokenEmail,
  parseDoubleTripleDigits,
  parseEmailTokenStream,
} from './spoken-email-normalizer.util';
import { assertEmailConfirmedBeforeCheckout } from './enterprise-checkout-state-machine.util';

test('letter-by-letter email b a s h i r s u l t a n seven six six', () => {
  const capture = captureEmailFromVoice(
    'b a s h i r s u l t a n seven six six at gmail dot com',
    { mode: 'spelling' },
  );
  assert.equal(capture.email, 'bashirsultan766@gmail.com');
  assert.ok(isEmailCaptureConfidenceSufficient(capture.confidence));
});

test('b for boy phonetic spelling', () => {
  const capture = captureEmailFromVoice(
    'b for boy a for apple s for sugar h for hotel at gmail dot com',
    { mode: 'spelling' },
  );
  assert.equal(capture.email, 'bash@gmail.com');
});

test('double and triple digit parsing in email', () => {
  assert.equal(parseDoubleTripleDigits('seven double six'), '766');
  assert.equal(normalizeSpokenEmail('bashir sultan seven double six at gmail dot com'), 'bashirsultan766@gmail.com');
});

test('low confidence blocks sufficient gate', () => {
  assert.equal(isEmailCaptureConfidenceSufficient(0.91), false);
  assert.equal(isEmailCaptureConfidenceSufficient(0.92), true);
});

test('wrong email negative confirmation', () => {
  assert.equal(isEmailConfirmationNegative('No, that is not correct'), true);
  assert.equal(isEmailConfirmationNegative('that is wrong'), true);
  assert.equal(isEmailConfirmationNegative('not my email'), true);
});

test('repeat captured email spellback detection', () => {
  assert.equal(isCallerAskingEmailSpellback('repeat my email please'), true);
  assert.equal(isCallerAskingEmailSpellback('what email did you capture'), true);
});

test('payment link blocked without confirmed email', () => {
  assert.throws(() => assertEmailConfirmedBeforeCheckout('pending'), /Checkout blocked: email not confirmed/);
});

test('token stream parser handles spaced letters', () => {
  const parsed = parseEmailTokenStream('b a s h i r at gmail dot com');
  assert.equal(parsed.email, 'bashir@gmail.com');
});

test('token stream parser handles custom business domain words', () => {
  const parsed = parseEmailTokenStream('jessica at sureshot books dot com');
  assert.equal(parsed.email, 'jessica@sureshotbooks.com');
});

test('inline this is correct only when not negative', () => {
  assert.equal(
    containsInlineEmailConfirmation('yes bashir at gmail dot com this is correct'),
    true,
  );
  assert.equal(
    containsInlineEmailConfirmation('no that is not correct bashir at gmail dot com'),
    false,
  );
});
