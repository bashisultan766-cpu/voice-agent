import test from 'node:test';
import assert from 'node:assert/strict';
import type { LlmAgentOrchestratorService } from './llm-agent-orchestrator.service';
import type { SessionContextService } from './session-context.service';
import { VoiceRuntimeService } from './voice-runtime.service';
import type { CallsService } from '../calls.service';
import type { RuntimeSafetyService } from './runtime-safety.service';
import type { TranscriptBufferService } from './transcript-buffer.service';
import { containsBannedVoicePhrase } from './voice-brain-reply.util';
import { selectInstantAcknowledgement } from '../../integrations/twilio/instant-acknowledgement.util';

function mockCtx() {
  return {
    tenantId: 'tenant_1',
    agentId: 'agent_1',
    storeId: 'store_1',
    metadata: {},
    agent: {
      openaiApiKey: 'sk-test',
      model: 'gpt-4o-mini',
      voiceProvider: 'elevenlabs',
      voiceId: 'v1',
      runtimeCredentialHints: { openaiKeySource: 'test' },
    },
    store: { name: 'SureShot Books' },
  };
}

function buildRuntime(overrides: {
  handleTurn: LlmAgentOrchestratorService['handleTurn'];
  productFastPathExecute?: () => Promise<{
    used: boolean;
    reply?: string;
    openaiCalled: false;
    product_fast_path_used: boolean;
    brain: 'deterministic_product_fast_path';
    localProductSearchMs?: number;
    shopifySkipped?: boolean;
    productFastPathConfidence?: number;
  }>;
}) {
  const sessionContext = {
    load: async () => mockCtx(),
  } as unknown as SessionContextService;

  const callsService = {
    mergeSessionMetadata: async () => ({}),
    findOneById: async () => ({ metadata: {} }),
    updateSessionStatus: async () => ({}),
  } as unknown as CallsService;

  const transcriptNormalizer = {
    normalizeTranscript: async (input: string) => ({
      raw: input.trim(),
      normalized: input.trim(),
      corrected: false,
      confidence: 'unchanged' as const,
    }),
  };

  const runtimeSafety = {
    checkUserInput: () => ({ blocked: false }),
    refusalReply: () => 'blocked',
  } as unknown as RuntimeSafetyService;

  const transcriptBuffer = {
    getNextSequence: async () => 1,
    append: async () => undefined,
    getConversationHistory: async () => [],
  } as unknown as TranscriptBufferService;

  const llmAgent = {
    handleTurn: overrides.handleTurn,
    processTurn: overrides.handleTurn,
  } as unknown as LlmAgentOrchestratorService;

  const callEvents = { log: async () => undefined } as unknown as import('../../analytics/call-events.service').CallEventsService;
  const conversationAnalytics = {
    recordRefusal: async () => undefined,
    recordToolLatency: async () => undefined,
  } as unknown as import('./conversation-analytics.service').ConversationAnalyticsService;

  return new VoiceRuntimeService(
    sessionContext,
    callsService,
    llmAgent,
    transcriptNormalizer as never,
    {} as never,
    callEvents,
    {} as never,
    transcriptBuffer,
    {} as never,
    runtimeSafety,
    {} as never,
    conversationAnalytics,
    {} as never,
    {} as never,
    { recordBreakdown: () => 'unknown' } as never,
    {
      execute:
        overrides.productFastPathExecute ??
        (async () => ({
          used: false,
          openaiCalled: false,
          product_fast_path_used: false,
          brain: 'deterministic_product_fast_path' as const,
        })),
    } as never,
  );
}

test('hello reply without OpenAI', async () => {
  let handleTurnCalls = 0;
  const runtime = buildRuntime({
    handleTurn: async () => {
      handleTurnCalls += 1;
      return {
        reply: 'should not be called',
        toolCallsCount: 0,
        toolNames: [],
        state: {
          selectedProducts: [],
          quantities: {},
          lastSearchedProducts: [],
          checkoutStage: 'idle',
          lastToolCalls: [],
        },
        proof: {
          openaiKeySource: 'test',
          modelUsed: 'gpt-4o-mini',
          openaiCalled: true,
          openaiSuccess: true,
        },
      };
    },
  });

  const { reply, turnProof } = await runtime.processUtterance('sess_brain_hello', 'hello', []);
  assert.equal(handleTurnCalls, 0);
  assert.match(reply, /Hello/i);
  assert.equal(turnProof?.openaiCalled, false);
  assert.equal(turnProof?.instant_reply_used, true);
});

test('how are you reply without OpenAI', async () => {
  let handleTurnCalls = 0;
  const runtime = buildRuntime({
    handleTurn: async () => {
      handleTurnCalls += 1;
      return {
        reply: "I'm doing well. What book can I help you find today?",
        toolCallsCount: 0,
        toolNames: [],
        state: {
          selectedProducts: [],
          quantities: {},
          lastSearchedProducts: [],
          checkoutStage: 'idle',
          lastToolCalls: [],
        },
        proof: {
          openaiKeySource: 'test',
          modelUsed: 'gpt-4o-mini',
          openaiCalled: true,
          openaiSuccess: true,
        },
      };
    },
  });

  const { reply, turnProof } = await runtime.processUtterance('sess_brain_1', 'how are you', []);
  assert.equal(handleTurnCalls, 0);
  assert.match(reply, /doing great|help/i);
  assert.equal(turnProof?.openaiCalled, false);
  for (const bad of ['let me check', 'thank you for asking', 'go ahead', 'one moment']) {
    assert.doesNotMatch(reply.toLowerCase(), new RegExp(bad, 'i'));
  }
});

test('history book uses product fast path without OpenAI', async () => {
  let handleTurnCalls = 0;
  const runtime = buildRuntime({
    handleTurn: async () => {
      handleTurnCalls += 1;
      return {
        reply: 'should not run',
        toolCallsCount: 0,
        toolNames: [],
        state: { checkoutStage: 'idle' } as never,
      };
    },
    productFastPathExecute: async () => ({
      used: true,
      reply: 'Yes, I found World History Vol 1. The price is 24.99.',
      localProductSearchMs: 120,
      shopifySkipped: true,
      productFastPathConfidence: 0.9,
      openaiCalled: false,
      product_fast_path_used: true,
      brain: 'deterministic_product_fast_path',
    }),
  });

  const { reply, turnProof } = await runtime.processUtterance('sess_brain_2', 'I need a history book', []);
  assert.equal(handleTurnCalls, 0);
  assert.equal(turnProof?.openaiCalled, false);
  assert.equal(turnProof?.brain, 'deterministic_product_fast_path');
  assert.match(reply, /World History/i);
});

test('product search ack uses short cached phrase', () => {
  const sel = selectInstantAcknowledgement({
    intent: 'product_search',
    speechText: 'do you have atomic habits',
    callState: 'IDLE',
    metadata: {},
    forceElevenLabsOnly: false,
  });
  assert.equal(sel.mode, 'deferred_kickoff');
  assert.match(sel.instantPhrase ?? '', /let me check/i);
});

test('containsBannedVoicePhrase detects robotic fillers', () => {
  assert.equal(containsBannedVoicePhrase('Just a moment, let me check that.'), true);
  assert.equal(containsBannedVoicePhrase('Thank you for asking.'), true);
  assert.equal(containsBannedVoicePhrase('Sure thing, I got you.'), true);
});
