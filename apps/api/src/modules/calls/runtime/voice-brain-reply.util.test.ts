import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAIN_CLEAN_FALLBACK_REPLY,
  containsBannedVoicePhrase,
  finalizeBrainReply,
  sanitizeBrainReply,
} from './voice-brain-reply.util';

test('sanitizeBrainReply removes go ahead and dropshipping', () => {
  const out = sanitizeBrainReply('Go ahead, we offer dropshipping.');
  assert.doesNotMatch(out, /go ahead/i);
  assert.doesNotMatch(out, /dropship/i);
});

test('finalizeBrainReply uses regenerate when banned', async () => {
  const out = await finalizeBrainReply('Thank you for asking. Let me check.', {
    regenerate: async () => "I'm doing well. What book can I help you find?",
  });
  assert.doesNotMatch(out, /let me check/i);
  assert.doesNotMatch(out, /thank you for asking/i);
});

test('finalizeBrainReply falls back to clean line when still banned', async () => {
  const out = await finalizeBrainReply('Thank you for asking.', {
    regenerate: async () => 'Go ahead, let me check.',
  });
  assert.equal(out, BRAIN_CLEAN_FALLBACK_REPLY);
});

test('containsBannedVoicePhrase flags one moment', () => {
  assert.equal(containsBannedVoicePhrase('One moment while I look that up.'), true);
});
