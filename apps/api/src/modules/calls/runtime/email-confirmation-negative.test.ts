/**
 * Negative email confirmation must override positive inline detection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsInlineEmailConfirmation,
  isEmailConfirmationAffirmative,
  isEmailConfirmationNegative,
  extractEmailFromSpeech,
  normalizeSpokenEmail,
} from './spoken-email-normalizer.util';
import { assertEmailConfirmedBeforeCheckout } from './enterprise-checkout-state-machine.util';

test('negative: "No, it\'s not correct" blocks inline confirmation', () => {
  const utterance = "No, it's not correct. Bashir sultan at gmail dot com";
  assert.equal(isEmailConfirmationNegative(utterance), true);
  assert.equal(containsInlineEmailConfirmation(utterance), false);
  assert.equal(isEmailConfirmationAffirmative(utterance), false);
});

test('negative: bare rejection without new email', () => {
  assert.equal(isEmailConfirmationNegative("No, it's not correct"), true);
  assert.equal(containsInlineEmailConfirmation("No, it's not correct"), false);
});

test('negative with correction email does not affirm or inline-confirm', () => {
  const utterance =
    "No, wrong email. It's bashir six four at gmail dot com";
  assert.equal(isEmailConfirmationNegative(utterance), true);
  assert.equal(containsInlineEmailConfirmation(utterance), false);
  assert.equal(isEmailConfirmationAffirmative(utterance), false);
  const email = extractEmailFromSpeech(utterance);
  assert.ok(email);
  assert.match(email ?? '', /@gmail\.com$/);
});

test('positive: "yes that\'s correct" allows confirmation without inline email', () => {
  assert.equal(isEmailConfirmationNegative("yes that's correct"), false);
  assert.equal(isEmailConfirmationAffirmative("yes that's correct"), true);
  assert.equal(containsInlineEmailConfirmation("yes that's correct"), false);
});

test('positive: inline email with explicit affirmation', () => {
  assert.equal(
    containsInlineEmailConfirmation('bashirsultan766@gmail.com this is correct'),
    true,
  );
  assert.equal(isEmailConfirmationNegative('bashirsultan766@gmail.com this is correct'), false);
});

test('assertEmailConfirmedBeforeCheckout throws when not confirmed', () => {
  assert.throws(
    () => assertEmailConfirmedBeforeCheckout('pending'),
    /Checkout blocked: email not confirmed/,
  );
  assert.throws(
    () => assertEmailConfirmedBeforeCheckout('rejected'),
    /Checkout blocked: email not confirmed/,
  );
  assert.doesNotThrow(() => assertEmailConfirmedBeforeCheckout('confirmed'));
});

test('Urdu negative phrases are detected', () => {
  assert.equal(isEmailConfirmationNegative('نہیں غلط ہے'), true);
  assert.equal(containsInlineEmailConfirmation('نہیں غلط ہے'), false);
});

test('spell it again / repeat it are negative', () => {
  assert.equal(isEmailConfirmationNegative('spell it again please'), true);
  assert.equal(isEmailConfirmationNegative('let me repeat it'), true);
});
