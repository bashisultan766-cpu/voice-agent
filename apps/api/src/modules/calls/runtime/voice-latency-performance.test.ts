import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceLatencyAnalyzerService } from './voice-latency-analyzer.service';
import { VoiceLatencyTimer } from './voice-latency-breakdown.util';
import { shouldBypassOpenAI } from './instant-reply.engine';
import { VOICE_CACHED_PHRASES } from './instant-reply.util';
import { voiceSearchFillerThresholdMs } from './voice-commerce-fast-mode.util';

test('greeting intent detection completes under 300ms budget (synthetic)', () => {
  const started = Date.now();
  for (let i = 0; i < 500; i++) {
    shouldBypassOpenAI({ text: 'hello', orderState: 'IDLE' });
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 300, `intent detection loop took ${elapsed}ms`);
});

test('hello skips OpenAI', () => {
  const { bypass, openaiSkippedReason } = shouldBypassOpenAI({ text: 'hello', orderState: 'IDLE' });
  assert.equal(bypass, true);
  assert.equal(openaiSkippedReason, 'instant_deterministic_reply');
});

test('product ack phrase under 7 words', () => {
  const words = VOICE_CACHED_PHRASES.searchAck.split(/\s+/).filter(Boolean);
  assert.ok(words.length <= 7);
});

test('deferred breakdown marks openai skip for instant reply proof', () => {
  const analyzer = new VoiceLatencyAnalyzerService();
  const breakdown = analyzer.buildDeferredBreakdown({
    callSessionId: 'sess_perf',
    jobStartedAtMs: Date.now() - 900,
    llmLatencyMs: 50,
    ttsGenerationTimeMs: 120,
    turnProof: { instant_reply_used: true, openaiCalled: false },
  });
  assert.equal(breakdown.openaiCalled, false);
  assert.equal(breakdown.openaiSkippedReason, 'instant_deterministic_reply');
  assert.equal(breakdown.openaiMs, 0);
});

test('SLA root cause resolves to openai when dominant', () => {
  const analyzer = new VoiceLatencyAnalyzerService();
  const cause = analyzer.resolveRootCause({
    openaiMs: 1800,
    ttsMs: 200,
    totalCallerWaitMs: 2100,
  });
  assert.equal(cause, 'openai');
});

test('latency timer captures twiml return under synthetic hot path', () => {
  const timer = new VoiceLatencyTimer();
  timer.startSection('intentDetectionMs');
  shouldBypassOpenAI({ text: 'hi', orderState: 'IDLE' });
  timer.endSection('intentDetectionMs');
  timer.mark('openaiMs', 0);
  timer.mark('ttsMs', 0);
  const breakdown = timer.toBreakdown({ route: 'gather_sync_social_reply', instantReplyUsed: true });
  assert.ok((breakdown.totalCallerWaitMs ?? 999) < 300);
});

test('fast mode filler threshold defaults to 700ms when env unset', () => {
  const prev = process.env.VOICE_SEARCH_FILLER_THRESHOLD_MS;
  const prevFast = process.env.VOICE_COMMERCE_FAST_MODE;
  delete process.env.VOICE_SEARCH_FILLER_THRESHOLD_MS;
  process.env.VOICE_COMMERCE_FAST_MODE = 'true';
  try {
    assert.equal(voiceSearchFillerThresholdMs(), 700);
  } finally {
    if (prev === undefined) delete process.env.VOICE_SEARCH_FILLER_THRESHOLD_MS;
    else process.env.VOICE_SEARCH_FILLER_THRESHOLD_MS = prev;
    if (prevFast === undefined) delete process.env.VOICE_COMMERCE_FAST_MODE;
    else process.env.VOICE_COMMERCE_FAST_MODE = prevFast;
  }
});
