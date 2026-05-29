import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVoiceProviderEnforcedLog,
  resolveVoiceProviderPolicy,
  shouldPlayDeferredSearchFiller,
} from './voice-provider-policy.util';

test('FORCE_ELEVENLABS_ONLY=true blocks Twilio Say', () => {
  const policy = resolveVoiceProviderPolicy({
    FORCE_ELEVENLABS_ONLY: 'true',
    FORCE_TWILIO_FALLBACK: 'false',
    STRICT_ELEVENLABS_ONLY: 'false',
  });
  assert.equal(policy.twilioSayBlocked, true);
  assert.equal(policy.forceElevenLabsOnly, true);
  const log = buildVoiceProviderEnforcedLog(policy);
  assert.equal(log.event, 'voice_provider_enforced');
  assert.equal(log.provider, 'elevenlabs');
  assert.equal(log.twilioSayBlocked, true);
});

test('FORCE_TWILIO_FALLBACK=true allows Twilio Say even with FORCE_ELEVENLABS_ONLY', () => {
  const policy = resolveVoiceProviderPolicy({
    FORCE_ELEVENLABS_ONLY: 'true',
    FORCE_TWILIO_FALLBACK: 'true',
  });
  assert.equal(policy.twilioSayBlocked, false);
  assert.equal(policy.forceTwilioFallback, true);
});

test('STRICT_ELEVENLABS_ONLY defaults to blocking Twilio Say', () => {
  const policy = resolveVoiceProviderPolicy({});
  assert.equal(policy.twilioSayBlocked, true);
});

test('shouldPlayDeferredSearchFiller is false when ElevenLabs-only', () => {
  const policy = resolveVoiceProviderPolicy({ FORCE_ELEVENLABS_ONLY: 'true' });
  assert.equal(shouldPlayDeferredSearchFiller(policy), false);
});
