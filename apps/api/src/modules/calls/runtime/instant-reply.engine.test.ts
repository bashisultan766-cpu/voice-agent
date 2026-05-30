import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldBypassOpenAI,
  buildInstantEngineReply,
  resolveInstantAudioPhrase,
} from './instant-reply.engine';
import { VOICE_CACHED_PHRASES } from './instant-reply.util';

test('hello skips OpenAI via shouldBypassOpenAI', () => {
  const result = shouldBypassOpenAI({ text: 'hello', orderState: 'IDLE' });
  assert.equal(result.bypass, true);
  assert.equal(result.openaiSkippedReason, 'instant_deterministic_reply');
});

test('product search does not bypass OpenAI', () => {
  const result = shouldBypassOpenAI({
    text: 'do you have Atomic Habits',
    orderState: 'IDLE',
  });
  assert.equal(result.bypass, false);
});

test('thank you skips OpenAI', () => {
  const result = shouldBypassOpenAI({ text: 'thank you', orderState: 'IDLE' });
  assert.equal(result.bypass, true);
});

test('goodbye skips OpenAI', () => {
  const result = shouldBypassOpenAI({ text: 'goodbye', orderState: 'IDLE' });
  assert.equal(result.bypass, true);
  assert.equal(result.instantKind, 'goodbye');
});

test('instant audio phrase maps to cached canonical text', () => {
  assert.equal(resolveInstantAudioPhrase('hello'), VOICE_CACHED_PHRASES.greeting);
  assert.equal(resolveInstantAudioPhrase('thank you'), VOICE_CACHED_PHRASES.thanks);
  assert.equal(resolveInstantAudioPhrase('assalamu alaikum'), VOICE_CACHED_PHRASES.salam);
});

test('greeting reply stays under 8 words', () => {
  const words = buildInstantEngineReply('hello').split(/\s+/).filter(Boolean);
  assert.ok(words.length <= 8);
});

test('product search ack stays under 7 words', () => {
  const words = VOICE_CACHED_PHRASES.searchAck.split(/\s+/).filter(Boolean);
  assert.ok(words.length <= 7);
});
