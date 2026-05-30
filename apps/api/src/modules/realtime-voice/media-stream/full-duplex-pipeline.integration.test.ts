import '../testing/register-mocks';
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFullDuplexTestHarness,
  startHarnessSession,
} from '../testing/test-harness';
import { TEST_STREAM_SID, TEST_CALL_SID } from '../testing/test-ids';
import {
  twilioConnectedEvent,
  twilioStartEvent,
  twilioInboundMediaEvent,
  twilioStopEvent,
  SAMPLE_MULAW_B64,
} from '../testing/mocks/mock-twilio-media-stream';
import { parseTwilioMediaMessage } from './twilio-media-protocol.util';
import { resetMockElevenLabsTts, getMockElevenLabsSpeakCalls } from '../testing/mocks/mock-elevenlabs-tts';

describe('Twilio Media Stream lifecycle', () => {
  test('connected → start → media → mark → stop', async () => {
    const harness = createFullDuplexTestHarness();
    const { pipeline, twilioWs } = harness;

    await pipeline.onTwilioConnected(twilioWs as never, harness.sessionContext.callSessionId);
    const afterConnected = harness.metricsStore.get(harness.sessionContext.callSessionId);
    assert.equal(afterConnected?.streamingStatus, 'listening');
    assert.equal(afterConnected?.pipelineMode, 'full_duplex');

    await startHarnessSession(harness);

    const meta = harness.metadataStore.get(harness.sessionContext.callSessionId);
    assert.equal(meta?.mediaStreamConnected, true);
    assert.equal(meta?.fullDuplexPipeline, true);
    assert.equal(meta?.twilioStreamSid, TEST_STREAM_SID);

    pipeline.onTwilioMedia(harness.sessionContext.callSessionId, SAMPLE_MULAW_B64);
    assert.ok(harness.openaiBridge!.appendedAudio.length >= 1);

    await pipeline.onTwilioStop(harness.sessionContext.callSessionId);
    assert.equal(harness.pipeline.getSession(harness.sessionContext.callSessionId), undefined);

    const afterStop = harness.metricsStore.get(harness.sessionContext.callSessionId);
    assert.equal(afterStop?.streamingStatus, 'idle');
  });

  test('gateway protocol events parse correctly', () => {
    assert.equal(parseTwilioMediaMessage(twilioConnectedEvent())?.event, 'connected');
    assert.equal(parseTwilioMediaMessage(twilioStartEvent({
      streamSid: TEST_STREAM_SID,
      callSid: TEST_CALL_SID,
      callSessionId: 'sess_proto_test',
    }))?.event, 'start');
    assert.equal(parseTwilioMediaMessage(twilioInboundMediaEvent())?.media?.track, 'inbound');
    assert.equal(parseTwilioMediaMessage(twilioStopEvent())?.event, 'stop');
  });
});

describe('Audio pipeline', () => {
  test('inbound mulaw forwarded to OpenAI and outbound media returned to Twilio', async () => {
    const harness = createFullDuplexTestHarness();
    const bridge = await startHarnessSession(harness);

    harness.pipeline.onTwilioMedia(harness.sessionContext.callSessionId, SAMPLE_MULAW_B64);
    assert.deepEqual(bridge.appendedAudio, [SAMPLE_MULAW_B64]);

    const mediaOut = harness.twilioWs.mediaPayloads();
    assert.ok(mediaOut.length >= 1, 'greeting TTS should emit outbound media');
    assert.ok(mediaOut[0].length > 0);

    const marks = harness.twilioWs.markEvents();
    assert.ok(marks.length >= 1);
    assert.match(marks[0].name, /^tts_/);
  });
});

describe('Barge-in', () => {
  test('speech_started cancels TTS and sends Twilio clear', async () => {
    const harness = createFullDuplexTestHarness();
    const bridge = await startHarnessSession(harness);

    const session = harness.pipeline.getSession(harness.sessionContext.callSessionId)!;
    session.speaking = true;
    session.ttsAbort = new AbortController();

    bridge.controls().emitSpeechStart();
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(harness.twilioWs.clearEvents() >= 1, 'should send Twilio clear on barge-in');
    const metrics = harness.metricsStore.get(harness.sessionContext.callSessionId);
    assert.ok((metrics?.interruptionCount as number) >= 1);
    assert.equal(session.speaking, false);
  });
});

describe('Agent orchestration', () => {
  test('final transcript triggers orchestrator with filler then reply', async () => {
    const harness = createFullDuplexTestHarness();
    const bridge = await startHarnessSession(harness);
    harness.twilioWs.sent.length = 0;

    bridge.controls().emitSpeechStart();
    await new Promise((r) => setTimeout(r, 10));
    bridge.controls().emitFinalTranscript('Do you have Dune?');
    await new Promise((r) => setTimeout(r, 400));

    assert.ok(harness.transcriptLog.some((t) => t.role === 'user' && t.text.includes('Dune')));
    assert.ok(harness.transcriptLog.some((t) => t.role === 'agent'));

    const metrics = harness.metricsStore.get(harness.sessionContext.callSessionId);
    assert.ok(typeof metrics?.agentLatencyMs === 'number');
    assert.ok(typeof metrics?.shopifyLatencyMs === 'number');
    assert.ok(typeof metrics?.sttLatencyMs === 'number' || metrics?.sttLatencyMs === null);
    assert.ok(typeof metrics?.totalVoiceTurnLatencyMs === 'number');

    const mediaOut = harness.twilioWs.mediaPayloads();
    assert.ok(mediaOut.length >= 1);
  });
});

describe('Failure recovery', () => {
  test('OpenAI Realtime connection failure triggers Gather fallback', async () => {
    const harness = createFullDuplexTestHarness({ openaiConnectFails: true, gatherFallbackEnabled: true });
    await harness.pipeline.onTwilioStart(
      harness.twilioWs as never,
      harness.sessionContext.callSessionId,
      TEST_STREAM_SID,
      TEST_CALL_SID,
    );
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(harness.fallbackCalls.length, 1);
    assert.match(harness.fallbackCalls[0].reason, /openai/);
    const metrics = harness.metricsStore.get(harness.sessionContext.callSessionId);
    assert.ok((metrics?.fallbackCount as number) >= 1);
  });

  test('Twilio WebSocket disconnect tears down session', async () => {
    const harness = createFullDuplexTestHarness();
    await startHarnessSession(harness);
    assert.ok(harness.pipeline.getSession(harness.sessionContext.callSessionId));

    await harness.pipeline.onTwilioClose(harness.sessionContext.callSessionId);
    assert.equal(harness.pipeline.getSession(harness.sessionContext.callSessionId), undefined);
  });

  test('orchestrator error still produces apology TTS attempt', async () => {
    const { setMockOrchestratorThrow, resetMockOrchestrator } = await import('../testing/mocks/mock-orchestrator');
    resetMockOrchestrator();
    setMockOrchestratorThrow(true);

    const harness = createFullDuplexTestHarness();
    const bridge = await startHarnessSession(harness);
    bridge.controls().emitFinalTranscript('Hello');
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(getMockElevenLabsSpeakCalls().some((c) => c.text.includes('snag')));
    resetMockOrchestrator();
  });
});
