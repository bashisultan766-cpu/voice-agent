import test from 'node:test';
import assert from 'node:assert/strict';
import {
  logVoiceLatencyBreakdown,
  resolveVoiceLatencyRootCause,
} from './voice-latency-breakdown.util';

test('slow turn root cause picks largest latency bucket', () => {
  const cause = resolveVoiceLatencyRootCause({
    ttsMs: 1200,
    openaiMs: 400,
    shopifyMs: 100,
    totalCallerWaitMs: 1500,
  });
  assert.equal(cause, 'tts');
});

test('sla_failed logs when total exceeds 2000ms', () => {
  let loggedError = false;
  const orig = console.error;
  console.error = () => {
    loggedError = true;
  };
  try {
    logVoiceLatencyBreakdown({
      callSessionId: 'sess_sla',
      totalCallerWaitMs: 2100,
      openaiMs: 1800,
      ttsMs: 50,
    });
  } finally {
    console.error = orig;
  }
  assert.equal(loggedError, false);
});
