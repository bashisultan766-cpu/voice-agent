import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isVoiceCommerceFastMode,
  voiceDeferredPollPauseSeconds,
  voiceShopifyMaxAttempts,
  voiceShopifySearchFirst,
} from './voice-commerce-fast-mode.util';

test('isVoiceCommerceFastMode respects env', () => {
  const prev = process.env.VOICE_COMMERCE_FAST_MODE;
  process.env.VOICE_COMMERCE_FAST_MODE = 'true';
  assert.equal(isVoiceCommerceFastMode(), true);
  process.env.VOICE_COMMERCE_FAST_MODE = '0';
  assert.equal(isVoiceCommerceFastMode(), false);
  if (prev === undefined) delete process.env.VOICE_COMMERCE_FAST_MODE;
  else process.env.VOICE_COMMERCE_FAST_MODE = prev;
});

test('fast mode tightens Shopify and poll defaults', () => {
  const prev = process.env.VOICE_COMMERCE_FAST_MODE;
  process.env.VOICE_COMMERCE_FAST_MODE = 'true';
  assert.equal(voiceShopifySearchFirst(), 12);
  assert.equal(voiceShopifyMaxAttempts(6), 3);
  assert.equal(voiceDeferredPollPauseSeconds(), 0.5);
  if (prev === undefined) delete process.env.VOICE_COMMERCE_FAST_MODE;
  else process.env.VOICE_COMMERCE_FAST_MODE = prev;
});
