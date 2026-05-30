import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRedisUrl,
  sanitizeRedisUrlForLog,
  REDIS_CLIENT_OPTIONS,
} from './redis-client.util';

test('normalizeRedisUrl replaces localhost with 127.0.0.1', () => {
  assert.equal(normalizeRedisUrl('redis://localhost:6379'), 'redis://127.0.0.1:6379');
});

test('normalizeRedisUrl replaces ::1 with 127.0.0.1', () => {
  assert.equal(normalizeRedisUrl('redis://[::1]:6379'), 'redis://127.0.0.1:6379');
  assert.equal(normalizeRedisUrl('redis://::1:6379'), 'redis://127.0.0.1:6379');
});

test('normalizeRedisUrl preserves explicit 127.0.0.1', () => {
  assert.equal(normalizeRedisUrl('redis://127.0.0.1:6379'), 'redis://127.0.0.1:6379');
});

test('sanitizeRedisUrlForLog redacts password', () => {
  const sanitized = sanitizeRedisUrlForLog('redis://:secret@127.0.0.1:6379');
  assert.match(sanitized, /127\.0\.0\.1/);
  assert.doesNotMatch(sanitized, /secret/);
});

test('REDIS_CLIENT_OPTIONS uses lazyConnect and retryStrategy cap', () => {
  assert.equal(REDIS_CLIENT_OPTIONS.lazyConnect, true);
  assert.equal(REDIS_CLIENT_OPTIONS.family, 4);
  assert.equal(REDIS_CLIENT_OPTIONS.enableOfflineQueue, false);
  const retry = REDIS_CLIENT_OPTIONS.retryStrategy!;
  assert.equal(retry(1), 100);
  assert.equal(retry(100), 3000);
});
