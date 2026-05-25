import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLegacyWebVoicePathAllowed,
  LEGACY_WEB_VOICE_PRODUCTION_BLOCK_MESSAGE,
} from '@bookstore-voice-agents/types';

test('legacy web voice path cannot run in production', () => {
  assert.equal(isLegacyWebVoicePathAllowed('production'), false);
  assert.equal(isLegacyWebVoicePathAllowed('test'), true);
  assert.match(LEGACY_WEB_VOICE_PRODUCTION_BLOCK_MESSAGE, /production/i);
});
