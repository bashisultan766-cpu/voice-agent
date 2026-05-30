import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRealtimePipelineFlags,
  isFullDuplexVoiceEnabled,
  readEnvFlag,
  resolveInboundVoicePipelinePath,
} from './realtime-voice-flags.util';

test('readEnvFlag accepts true, TRUE, 1, yes, on', () => {
  assert.equal(readEnvFlag('X', { X: 'true' }), true);
  assert.equal(readEnvFlag('X', { X: 'TRUE' }), true);
  assert.equal(readEnvFlag('X', { X: '1' }), true);
  assert.equal(readEnvFlag('X', { X: 'yes' }), true);
  assert.equal(readEnvFlag('X', { X: 'on' }), true);
  assert.equal(readEnvFlag('X', { X: 'false' }), false);
  assert.equal(readEnvFlag('X', { X: '' }), false);
});

test('isFullDuplexVoiceEnabled requires all three flags', () => {
  const env = {
    VOICE_MEDIA_STREAM_ENABLED: 'true',
    OPENAI_REALTIME_ENABLED: 'TRUE',
    REALTIME_MULTI_AGENT_ENABLED: '1',
  };
  assert.equal(isFullDuplexVoiceEnabled(env), true);
  assert.equal(resolveInboundVoicePipelinePath(env), 'full_duplex');

  const partial = { ...env, OPENAI_REALTIME_ENABLED: 'false' };
  assert.equal(isFullDuplexVoiceEnabled(partial), false);
  assert.equal(getRealtimePipelineFlags(partial).legacyMediaStream, true);
});
