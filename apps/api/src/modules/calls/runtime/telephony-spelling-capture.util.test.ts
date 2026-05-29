import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calculateSpellingConfidence,
  detectSpellingCadence,
  detectSpellingPattern,
  detectTwilioTranscriptCorruption,
  expandMergedSpellingLocalPart,
  isEmailCaptureConfidenceSufficient,
  normalizeSpellingTranscript,
  processTelephonySpellingPipeline,
  recoverEmailFromCorruptedSpellingTranscript,
} from './telephony-spelling-capture.util';

test('normalizeSpellingTranscript preserves isolated letters', () => {
  assert.equal(normalizeSpellingTranscript('D A S H I'), 'd a s h i');
  assert.equal(normalizeSpellingTranscript('B for boy'), 'b');
});

test('D A S H I does not collapse to Dashi', () => {
  const norm = normalizeSpellingTranscript('D A S H I S A A B');
  assert.match(norm, /d a s h i/);
  assert.doesNotMatch(norm, /dashi/i);
});

test('Twilio corruption Dashi Saab 64@gmail.com recovers to dashisaab64', () => {
  const raw = 'Dashi Saab 64@gmail.com';
  assert.equal(detectTwilioTranscriptCorruption(raw, normalizeSpellingTranscript(raw)), true);
  const recovered = recoverEmailFromCorruptedSpellingTranscript(raw);
  assert.equal(recovered.email, 'dashisaab64@gmail.com');
  assert.equal(recovered.recoveryTriggered, true);
});

test('seven double six stays 766 not sixty four', () => {
  const pipeline = processTelephonySpellingPipeline(
    'bashir seven double six at gmail dot com',
    { forceSpellingMode: true },
  );
  assert.equal(pipeline.email, 'bashir766@gmail.com');
});

test('low spelling confidence blocks checkout gate', () => {
  assert.equal(isEmailCaptureConfidenceSufficient(0.91), false);
  assert.equal(isEmailCaptureConfidenceSufficient(0.92), true);
});

test('cadence detected for spaced letters', () => {
  assert.equal(detectSpellingCadence('d a s h i s a a b 6 4'), true);
  assert.equal(detectSpellingPattern('d a s h i').kind, 'isolated_letters');
});

test('expandMergedSpellingLocalPart splits merged words', () => {
  const { expanded } = expandMergedSpellingLocalPart('Dashi Saab 64');
  assert.equal(expanded, 'dashisaab64');
});

test('pipeline logs corruption and recovery flags', () => {
  const pipeline = processTelephonySpellingPipeline('Dashi Saab 64@gmail.com', {
    forceSpellingMode: true,
  });
  assert.equal(pipeline.twilioTranscriptCorruptionDetected, true);
  assert.equal(pipeline.spellingRecoveryTriggered, true);
  assert.equal(pipeline.email, 'dashisaab64@gmail.com');
  assert.ok(pipeline.spellingConfidence > 0);
});

test('calculateSpellingConfidence penalizes corruption without recovery', () => {
  const low = calculateSpellingConfidence({
    raw: 'Dashi Saab',
    normalizedSpelling: 'dashi saab',
    email: 'wrong@gmail.com',
    parseMethod: 'direct',
    tokenStream: [],
    spellingPattern: detectSpellingPattern('Dashi Saab'),
    spellingCadenceDetected: false,
    twilioTranscriptCorruptionDetected: true,
    spellingRecoveryTriggered: false,
    baseCaptureConfidence: 0.96,
  });
  assert.ok(low < 0.92);
});
