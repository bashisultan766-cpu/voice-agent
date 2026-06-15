import test from 'node:test';
import assert from 'node:assert/strict';
import { recordInboundCallVisit, parseCallerCallHistory } from './caller-call-history.util';

test('recordInboundCallVisit increments total_calls and preserves first_seen_at', () => {
  const first = recordInboundCallVisit(null, {
    callSid: 'CA1',
    nowIso: '2025-01-01T10:00:00.000Z',
  });
  assert.equal(first.total_calls, 1);
  assert.equal(first.first_seen_at, '2025-01-01T10:00:00.000Z');

  const second = recordInboundCallVisit(first, {
    callSid: 'CA2',
    nowIso: '2025-01-02T10:00:00.000Z',
    lastOrderNumber: '#1010',
  });
  assert.equal(second.total_calls, 2);
  assert.equal(second.first_seen_at, '2025-01-01T10:00:00.000Z');
  assert.equal(second.last_call_sid, 'CA2');
  assert.equal(second.last_order_number, '#1010');
});

test('parseCallerCallHistory reads metadata.call_history', () => {
  const parsed = parseCallerCallHistory({
    call_history: {
      first_seen_at: '2025-01-01T10:00:00.000Z',
      last_seen_at: '2025-01-03T10:00:00.000Z',
      total_calls: 4,
      last_call_sid: 'CA4',
      last_order_number: '#2020',
      last_intent: 'order_lookup',
      last_call_summary: 'Tracking question',
    },
  });
  assert.ok(parsed);
  assert.equal(parsed?.total_calls, 4);
  assert.equal(parsed?.last_intent, 'order_lookup');
});
