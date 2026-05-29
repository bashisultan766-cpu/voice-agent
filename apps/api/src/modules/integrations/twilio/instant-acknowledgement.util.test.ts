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

test('product search sends instant ack phrase', () => {
  const sel = selectInstantAcknowledgement({
    intent: 'product_search',
    speechText: 'history book about Rome',
    callState: 'IDLE',
    metadata: {},
    forceElevenLabsOnly: false,
  });
  assert.equal(sel.mode, 'deferred_kickoff');
  if (sel.mode === 'deferred_kickoff') {
    assert.match(sel.instantPhrase ?? '', /let me check/i);
    assert.equal(sel.ackReason, 'product_search_instant_ack');
  }
});

test('greeting in idle uses sync full reply for instant social', () => {
  const sel = selectInstantAcknowledgement({
    intent: 'greeting',
    speechText: 'hello',
    callState: 'IDLE',
    metadata: {},
    forceElevenLabsOnly: false,
  });
  assert.equal(sel.mode, 'sync_full_reply');
  if (sel.mode === 'sync_full_reply') {
    assert.equal(sel.ackReason, 'instant_deterministic_sync');
  }
});
