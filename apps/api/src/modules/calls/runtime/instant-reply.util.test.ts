import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInstantReply,
  PRODUCT_SEARCH_FAST_ACK,
  shouldUseInstantReply,
} from './instant-reply.util';

test('hello uses instant reply without catalog signals', () => {
  assert.equal(shouldUseInstantReply('hello'), true);
  assert.match(buildInstantReply('hello'), /help you today/i);
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
