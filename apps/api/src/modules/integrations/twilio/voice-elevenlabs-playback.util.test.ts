import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildTtsPlaybackUrl,
  prepareVoiceTtsInputText,
  validateTtsAudioBuffer,
} from './voice-elevenlabs-playback.util';

describe('prepareVoiceTtsInputText', () => {
  it('compresses long replies for telephony TTS', () => {
    const long =
      'Hello! Thanks for calling. I found several history books for you. World History is twenty-four ninety-nine. ' +
      'We also have Atomic Habits and a civil war collection. Which title would you like to order today? ' +
      'I can send a secure payment link as soon as you pick one.';
    assert.ok(long.length > 200, `expected long reply, got ${long.length} chars`);
    const prepared = prepareVoiceTtsInputText(`  ${long}  `);
    assert.ok(prepared.length < long.length * 0.7);
    assert.ok(prepared.split(/[.!?]+/).filter(Boolean).length <= 2);
  });
});

describe('validateTtsAudioBuffer', () => {
  it('accepts large MP3 buffers for Play URL hosting', () => {
    const largeMp3 = Buffer.alloc(176_422, 0);
    largeMp3[0] = 0xff;
    largeMp3[1] = 0xfb;

    const result = validateTtsAudioBuffer(largeMp3);
    assert.equal(result.valid, true);
    assert.equal(result.contentType, 'audio/mpeg');
  });

  it('rejects empty buffers', () => {
    const result = validateTtsAudioBuffer(Buffer.alloc(0));
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'empty_audio');
  });
});

describe('buildTtsPlaybackUrl', () => {
  it('returns HTTPS Play URL for Twilio streaming', () => {
    const url = buildTtsPlaybackUrl('https://example.ngrok.app', 'abc123');
    assert.equal(url, 'https://example.ngrok.app/api/twilio/voice/tts/abc123');
  });
});
