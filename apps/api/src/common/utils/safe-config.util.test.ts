import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configGet, configGetNumber, configGetString } from './safe-config.util';

test('configGet returns undefined when config is null', () => {
  assert.equal(configGet(null, 'PORT'), undefined);
});

test('configGetNumber uses fallback when config missing', () => {
  assert.equal(configGetNumber(null, 'REALTIME_VOICE_SEARCH_DEADLINE_MS', 800), 800);
});

test('configGetNumber parses env from ConfigService', () => {
  const config = { get: (key: string) => (key === 'X' ? '1200' : undefined) };
  assert.equal(configGetNumber(config as never, 'X', 800), 1200);
});

test('configGetString trims and falls back', () => {
  assert.equal(configGetString(null, 'K', 'default'), 'default');
});
