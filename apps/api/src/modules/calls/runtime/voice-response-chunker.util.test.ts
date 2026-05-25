import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkTextForVoiceStream, firstSpeakableChunk } from './voice-response-chunker.util';

test('firstSpeakableChunk returns opening sentence', () => {
  const c = firstSpeakableChunk('I found Dune. It is available for twelve dollars. Want the link?');
  assert.match(c, /I found Dune/);
});

test('chunkTextForVoiceStream splits long text', () => {
  const chunks = chunkTextForVoiceStream('One. Two. Three. Four. Five. Six.');
  assert.ok(chunks.length >= 2);
});
