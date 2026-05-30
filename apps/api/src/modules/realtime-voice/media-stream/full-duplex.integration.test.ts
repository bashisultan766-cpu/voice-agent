import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTwilioMediaMessage,
  buildTwilioMediaPayload,
  buildTwilioClearPayload,
  buildTwilioMarkPayload,
  isInboundMulawMedia,
  extractCallSessionId,
  splitTextForStreamingTts,
} from './twilio-media-protocol.util';
import {
  isFullDuplexVoiceEnabled,
  isGatherFallbackEnabled,
  isLegacyMediaStreamEnabled,
} from '../config/realtime-voice-flags.util';

test('parseTwilioMediaMessage handles connected event', () => {
  const msg = parseTwilioMediaMessage(JSON.stringify({ event: 'connected', protocol: 'Call' }));
  assert.equal(msg?.event, 'connected');
});

test('parseTwilioMediaMessage handles start event with callSessionId param', () => {
  const raw = JSON.stringify({
    event: 'start',
    streamSid: 'MZ123',
    start: {
      callSid: 'CA456',
      customParameters: { callSessionId: 'sess_abc' },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    },
  });
  const msg = parseTwilioMediaMessage(raw);
  assert.equal(msg?.event, 'start');
  assert.equal(extractCallSessionId(msg!, ''), 'sess_abc');
  assert.equal(msg?.start?.callSid, 'CA456');
});

test('isInboundMulawMedia detects inbound track', () => {
  const msg = parseTwilioMediaMessage(
    JSON.stringify({
      event: 'media',
      media: { track: 'inbound', payload: 'abc123' },
    }),
  );
  assert.equal(isInboundMulawMedia(msg!), true);
});

test('buildTwilioMediaPayload produces valid outbound frame', () => {
  const payload = buildTwilioMediaPayload('MZ123', 'dGVzdA==');
  const parsed = JSON.parse(payload) as { event: string; streamSid: string; media: { payload: string } };
  assert.equal(parsed.event, 'media');
  assert.equal(parsed.streamSid, 'MZ123');
  assert.equal(parsed.media.payload, 'dGVzdA==');
});

test('buildTwilioClearPayload clears stream', () => {
  const parsed = JSON.parse(buildTwilioClearPayload('MZ123')) as { event: string };
  assert.equal(parsed.event, 'clear');
});

test('buildTwilioMarkPayload sets mark name', () => {
  const parsed = JSON.parse(buildTwilioMarkPayload('MZ123', 'tts_1')) as {
    event: string;
    mark: { name: string };
  };
  assert.equal(parsed.event, 'mark');
  assert.equal(parsed.mark.name, 'tts_1');
});

test('splitTextForStreamingTts splits sentences', () => {
  const chunks = splitTextForStreamingTts('Let me check. I found Dune.');
  assert.ok(chunks.length >= 2);
});

test('isFullDuplexVoiceEnabled requires all three flags', () => {
  const prev = { ...process.env };
  process.env.VOICE_MEDIA_STREAM_ENABLED = 'true';
  process.env.OPENAI_REALTIME_ENABLED = 'true';
  process.env.REALTIME_MULTI_AGENT_ENABLED = 'true';
  assert.equal(isFullDuplexVoiceEnabled(), true);

  process.env.OPENAI_REALTIME_ENABLED = 'false';
  assert.equal(isFullDuplexVoiceEnabled(), false);
  assert.equal(isLegacyMediaStreamEnabled(), true);

  process.env.GATHER_FALLBACK_ENABLED = 'false';
  assert.equal(isGatherFallbackEnabled(), false);

  process.env = prev;
});
