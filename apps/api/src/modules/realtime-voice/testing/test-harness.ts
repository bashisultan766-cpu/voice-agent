import { FullDuplexPipelineService } from '../media-stream/full-duplex-pipeline.service';
import { RealtimeVoiceMetricsService } from '../media-stream/realtime-voice-metrics.service';
import { MediaStreamFallbackService } from '../media-stream/media-stream-fallback.service';
import { VoiceEventBusService } from '../events/voice-event-bus.service';
import { VoiceStreamMetricsService } from '../../calls/runtime/voice-stream-metrics.service';
import type { VoiceSessionContext } from '../../calls/runtime/session-context.service';
import {
  createMockOpenAiBridgeFactory,
  type MockOpenAiRealtimeBridge,
} from './mocks/mock-openai-realtime-bridge';
import { createMockOrchestratorService } from './mocks/mock-orchestrator';
import { MockTwilioMediaStreamWs } from './mocks/mock-twilio-media-stream';
import { ConfigService } from '@nestjs/config';

export type TestHarness = {
  pipeline: FullDuplexPipelineService;
  twilioWs: MockTwilioMediaStreamWs;
  openaiInstances: MockOpenAiRealtimeBridge[];
  metricsStore: Map<string, Record<string, unknown>>;
  metadataStore: Map<string, Record<string, unknown>>;
  fallbackCalls: Array<{ callSessionId: string; callSid: string; reason: string }>;
  transcriptLog: Array<{ role: string; text: string }>;
  sessionContext: VoiceSessionContext;
  openaiBridge: MockOpenAiRealtimeBridge | null;
};

const DEFAULT_SESSION_ID = 'test_session_001';
const DEFAULT_STREAM_SID = 'MZ_test_stream';
const DEFAULT_CALL_SID = 'CA_test_call';

export function buildDefaultSessionContext(callSessionId = DEFAULT_SESSION_ID): VoiceSessionContext {
  return {
    callSessionId,
    tenantId: 'tenant_test',
    storeId: 'store_test',
    agentId: 'agent_test',
    agent: {
      name: 'Test Books Agent',
      language: 'en',
      baseSystemPrompt: 'You are a bookstore agent.',
      openaiApiKey: 'sk-test-openai',
      elevenlabsApiKey: 'el-test-key',
      voiceId: 'voice_test_id',
      elevenlabsModel: 'eleven_turbo_v2_5',
      greetingMessage: 'Hi! Welcome to Test Books.',
    },
    store: { name: 'Test Books' },
  };
}

export type HarnessOptions = {
  callSessionId?: string;
  openaiConnectFails?: boolean;
  gatherFallbackEnabled?: boolean;
};

let sessionCounter = 0;

export function nextTestSessionId(prefix = 'test_session'): string {
  sessionCounter += 1;
  return `${prefix}_${sessionCounter}_${Date.now()}`;
}

export function createFullDuplexTestHarness(opts: HarnessOptions = {}): TestHarness {
  const callSessionId = opts.callSessionId ?? nextTestSessionId();
  const twilioWs = new MockTwilioMediaStreamWs();
  const openaiInstances: MockOpenAiRealtimeBridge[] = [];
  const metricsStore = new Map<string, Record<string, unknown>>();
  const metadataStore = new Map<string, Record<string, unknown>>();
  const fallbackCalls: TestHarness['fallbackCalls'] = [];
  const transcriptLog: TestHarness['transcriptLog'] = [];
  const sessionContext = buildDefaultSessionContext(callSessionId);

  const streamMetrics = {
    async load(id: string) {
      return (metricsStore.get(id) ?? {}) as Record<string, unknown>;
    },
    async merge(id: string, patch: Record<string, unknown>) {
      const cur = metricsStore.get(id) ?? {};
      metricsStore.set(id, { ...cur, ...patch, lastUpdatedAt: new Date().toISOString() });
      return metricsStore.get(id)!;
    },
    async recordBargeIn(id: string) {
      const cur = (metricsStore.get(id) ?? {}) as { interruptionCount?: number };
      await streamMetrics.merge(id, {
        interruptionCount: (cur.interruptionCount ?? 0) + 1,
        streamingStatus: 'interrupted',
        agentSpeaking: false,
      });
    },
    async recordPartialTranscript(id: string, partial: string) {
      await streamMetrics.merge(id, { partialTranscript: partial.slice(0, 500), streamingStatus: 'listening' });
    },
  };

  const metrics = new RealtimeVoiceMetricsService(streamMetrics as unknown as VoiceStreamMetricsService);

  const callsService = {
    async mergeSessionMetadata(id: string, patch: Record<string, unknown>) {
      const cur = metadataStore.get(id) ?? {};
      metadataStore.set(id, { ...cur, ...patch });
    },
  };

  const transcriptBuffer = {
    seq: 0,
    async getNextSequence(_id: string) {
      transcriptBuffer.seq += 1;
      return transcriptBuffer.seq;
    },
    async append(_id: string, role: string, text: string) {
      transcriptLog.push({ role, text });
    },
  };

  const sessionContextService = {
    async load(id: string) {
      if (id !== callSessionId) return null;
      return sessionContext;
    },
  };

  const openaiBridgeService = createMockOpenAiBridgeFactory(openaiInstances, 5, opts.openaiConnectFails);

  const orchestrator = createMockOrchestratorService();

  const prevGather = process.env.GATHER_FALLBACK_ENABLED;
  if (opts.gatherFallbackEnabled !== undefined) {
    process.env.GATHER_FALLBACK_ENABLED = opts.gatherFallbackEnabled ? 'true' : 'false';
  }

  const config = {
    get: (key: string) => {
      if (key === 'PUBLIC_WEBHOOK_BASE_URL') return 'https://test.example.com';
      return process.env[key];
    },
  };

  const fallback = new MediaStreamFallbackService(config as ConfigService, callsService as never);
  const origRedirect = fallback.redirectToGather.bind(fallback);
  fallback.redirectToGather = async (id, sid, reason) => {
    fallbackCalls.push({ callSessionId: id, callSid: sid, reason });
    if (opts.gatherFallbackEnabled === false) return;
    await callsService.mergeSessionMetadata(id, {
      mediaStreamFallback: true,
      mediaStreamFallbackReason: reason,
      fullDuplexPipeline: false,
    });
  };

  const events = new VoiceEventBusService();
  const e2eTrace = {
    resolveTraceId: () => undefined,
    startTrace: () => 'vtrace_test',
    record: async () => undefined,
    finishTrace: async () => null,
  };

  const pipeline = new FullDuplexPipelineService(
    sessionContextService as never,
    callsService as never,
    transcriptBuffer as never,
    orchestrator as never,
    openaiBridgeService as never,
    metrics,
    fallback,
    events,
    e2eTrace as never,
  );

  if (opts.gatherFallbackEnabled !== undefined) {
    process.env.GATHER_FALLBACK_ENABLED = prevGather;
  }

  return {
    pipeline,
    twilioWs,
    openaiInstances,
    metricsStore,
    metadataStore,
    fallbackCalls,
    transcriptLog,
    sessionContext,
    openaiBridge: null,
  };
}

export async function startHarnessSession(harness: TestHarness): Promise<MockOpenAiRealtimeBridge> {
  process.env.ELEVENLABS_STREAMING_TTS_ENABLED = 'true';
  const sessionId = harness.sessionContext.callSessionId;
  await harness.pipeline.onTwilioConnected(
    harness.twilioWs as unknown as import('ws').WebSocket,
    sessionId,
  );
  await harness.pipeline.onTwilioStart(
    harness.twilioWs as unknown as import('ws').WebSocket,
    sessionId,
    DEFAULT_STREAM_SID,
    DEFAULT_CALL_SID,
  );
  const bridge = harness.openaiInstances[0] ?? null;
  harness.openaiBridge = bridge;
  if (!bridge) throw new Error('OpenAI bridge not created');
  return bridge;
}
