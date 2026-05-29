import test from 'node:test';
import assert from 'node:assert/strict';
import { selectInstantAcknowledgement } from './instant-acknowledgement.util';

test('forceElevenLabsOnly suppresses let-me-check instant ack phrases', () => {
  const sel = selectInstantAcknowledgement({
    intent: 'product_search',
    speechText: 'history book about Rome',
    callState: 'IDLE',
    metadata: {},
    forceElevenLabsOnly: true,
  });
  assert.equal(sel.mode, 'deferred_kickoff');
  if (sel.mode === 'deferred_kickoff') {
    assert.equal(sel.instantPhrase, null);
    assert.equal(sel.markSessionLetMeCheck, false);
  }
});

test('product question without forceElevenLabsOnly may use instant phrase in fast mode', () => {
  const sel = selectInstantAcknowledgement({
    intent: 'product_question',
    speechText: 'how much is shipping',
    callState: 'IDLE',
    metadata: {},
    forceElevenLabsOnly: false,
  });
  assert.equal(sel.mode, 'deferred_kickoff');
});
