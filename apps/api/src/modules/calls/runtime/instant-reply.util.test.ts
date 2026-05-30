import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInstantReply,
  instantReplyAudioPhrase,
  PRODUCT_SEARCH_FAST_ACK,
  shouldUseInstantReply,
  VOICE_CACHED_PHRASES,
} from './instant-reply.util';

test('hello uses instant reply without catalog signals', () => {
  assert.equal(shouldUseInstantReply('hello'), true);
  assert.match(buildInstantReply('hello'), /help/i);
});

test('how are you uses instant reply', () => {
  assert.equal(shouldUseInstantReply('how are you'), true);
  assert.match(buildInstantReply('how are you'), /doing great/i);
});

test('product title does not use instant reply', () => {
  assert.equal(shouldUseInstantReply('do you have a history book about Rome'), false);
});

test('assalamu alaikum instant reply', () => {
  assert.equal(shouldUseInstantReply('assalamu alaikum'), true);
  assert.match(buildInstantReply('assalamu alaikum'), /Wa alaikum salam/i);
});

test('product search fast ack phrase', () => {
  assert.match(PRODUCT_SEARCH_FAST_ACK, /let me check/i);
});

test('instantReplyAudioPhrase returns cached canonical strings', () => {
  assert.equal(instantReplyAudioPhrase('hello'), VOICE_CACHED_PHRASES.greeting);
  assert.equal(instantReplyAudioPhrase('yes'), VOICE_CACHED_PHRASES.yes);
  assert.equal(instantReplyAudioPhrase('goodbye'), VOICE_CACHED_PHRASES.goodbye);
});
