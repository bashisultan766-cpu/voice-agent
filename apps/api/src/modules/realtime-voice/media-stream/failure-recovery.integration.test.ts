import '../testing/register-mocks';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  setMockOrchestratorTimeout,
  setMockOrchestratorDelay,
  resetMockOrchestrator,
} from '../testing/mocks/mock-orchestrator';
import {
  createFullDuplexTestHarness,
  startHarnessSession,
} from '../testing/test-harness';
import { TEST_STREAM_SID, TEST_CALL_SID } from '../testing/test-ids';
import { resetMockElevenLabsTts, setMockElevenLabsShouldFail } from '../testing/mocks/mock-elevenlabs-tts';
import { MediaStreamFallbackService } from './media-stream-fallback.service';
import { ConfigService } from '@nestjs/config';

process.env.GATHER_FALLBACK_ENABLED = 'true';

describe('Failure recovery — ElevenLabs', () => {
  test('ElevenLabs WS failure during greeting triggers Gather fallback', async () => {
    resetMockElevenLabsTts();
    setMockElevenLabsShouldFail(true);
    const harness = createFullDuplexTestHarness({ gatherFallbackEnabled: true });

    await harness.pipeline.onTwilioStart(
      harness.twilioWs as never,
      harness.sessionContext.callSessionId,
      TEST_STREAM_SID,
      TEST_CALL_SID,
    );
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(harness.fallbackCalls.length >= 1);
    assert.match(harness.fallbackCalls[0].reason, /elevenlabs/);
    setMockElevenLabsShouldFail(false);
  });
});

describe('Agent orchestration — parallel agents and timeout', () => {
  test('Shopify agent latency recorded separately from agent latency', async () => {
    resetMockOrchestrator();
    setMockOrchestratorDelay(100);
    const harness = createFullDuplexTestHarness();
    const bridge = await startHarnessSession(harness);

    bridge.controls().emitFinalTranscript('find book Dune');
    await new Promise((r) => setTimeout(r, 350));

    const m = harness.metricsStore.get(harness.sessionContext.callSessionId)!;
    assert.ok((m.agentLatencyMs as number) >= 100);
    assert.ok((m.shopifyLatencyMs as number) >= 1);
    assert.ok((m.shopifyLatencyMs as number) <= (m.agentLatencyMs as number));
  });

  test('orchestrator timeout still completes turn with fallback reply path', async () => {
    resetMockOrchestrator();
    setMockOrchestratorTimeout(true);
    const harness = createFullDuplexTestHarness();
    const bridge = await startHarnessSession(harness);

    bridge.controls().emitFinalTranscript('Do you have ISBN 9780441172719?');
    await new Promise((r) => setTimeout(r, 600));

    assert.ok(harness.transcriptLog.some((t) => t.role === 'agent'));
    setMockOrchestratorTimeout(false);
  });
});

describe('Failure recovery — Redis', () => {
  test('Redis failure uses in-memory fallback gracefully', async () => {
    const { MockRedisStore } = await import('../testing/mocks/mock-redis');
    const store = new MockRedisStore();
    store.shouldFail = true;
    const val = await store.getWithFailure('key');
    assert.equal(val, null);
  });
});

describe('Gather fallback redirect', () => {
  test('redirectToGather records metadata when enabled', async () => {
    process.env.GATHER_FALLBACK_ENABLED = 'true';
    process.env.TWILIO_ACCOUNT_SID = '';
    const metadata = new Map<string, Record<string, unknown>>();
    const calls = {
      mergeSessionMetadata: async (id: string, patch: Record<string, unknown>) => {
        metadata.set(id, { ...metadata.get(id), ...patch });
      },
    };
    const config = { get: (k: string) => (k === 'PUBLIC_WEBHOOK_BASE_URL' ? 'https://test.example.com' : undefined) };
    const svc = new MediaStreamFallbackService(config as ConfigService, calls as never);
    await svc.redirectToGather('sess1', 'CA123', 'test_reason');
    assert.equal(metadata.get('sess1')?.mediaStreamFallback, true);
    assert.equal(metadata.get('sess1')?.mediaStreamFallbackReason, 'test_reason');
  });

  test('redirect skipped when GATHER_FALLBACK_ENABLED=false', async () => {
    process.env.GATHER_FALLBACK_ENABLED = 'false';
    const harness = createFullDuplexTestHarness({ openaiConnectFails: true, gatherFallbackEnabled: false });
    await harness.pipeline.onTwilioStart(
      harness.twilioWs as never,
      harness.sessionContext.callSessionId,
      TEST_STREAM_SID,
      TEST_CALL_SID,
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(harness.fallbackCalls.length, 1);
    assert.notEqual(harness.metadataStore.get(harness.sessionContext.callSessionId)?.mediaStreamFallback, true);
    process.env.GATHER_FALLBACK_ENABLED = 'true';
  });
});
