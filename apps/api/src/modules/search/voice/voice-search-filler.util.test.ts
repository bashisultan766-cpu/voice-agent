import test from 'node:test';
import assert from 'node:assert/strict';
import { pickVoiceSearchFillerPhrase } from './voice-search-filler.util';

test('pickVoiceSearchFillerPhrase is stable per session', () => {
  const a = pickVoiceSearchFillerPhrase({
    callSessionId: 'sess-1',
    intent: 'product_search',
    queryPreview: 'harry potter',
  });
  const b = pickVoiceSearchFillerPhrase({
    callSessionId: 'sess-1',
    intent: 'product_search',
    queryPreview: 'harry potter',
  });
  assert.equal(a, b);
  assert.ok(a.length > 10);
});
