import test from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import { VoiceRuntimeService } from './voice-runtime.service';
import type { LlmAgentOrchestratorService } from './llm-agent-orchestrator.service';
import type { SessionContextService } from './session-context.service';
import type { CallsService } from '../calls.service';
import type { RuntimeSafetyService } from './runtime-safety.service';
import type { TranscriptBufferService } from './transcript-buffer.service';
import { containsBannedVoicePhrase } from './voice-brain-reply.util';

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

test('history book calls handleTurn then search tool via orchestrator mock', async () => {
  const internalTools: string[] = [];
  let completionStep = 0;

  const completionFn = async () => {
    completionStep += 1;
    if (completionStep === 1) {
      return {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: {
                    name: 'ShopifyProductSearch',
                    arguments: JSON.stringify({ query: 'history', searchType: 'category' }),
                  },
                },
              ],
            },
          },
        ],
      } as OpenAI.Chat.ChatCompletion;
    }
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content:
              'I found World History Vol 1 for $24.99 with 8 in stock. Would you like to order it?',
          },
        },
      ],
    } as OpenAI.Chat.ChatCompletion;
  };

  const { LlmAgentOrchestratorService } = await import('./llm-agent-orchestrator.service');
  const orchestrator = new LlmAgentOrchestratorService(
    { get: () => undefined } as never,
    {
      load: async () => mockCtx() as never,
    } as never,
    {
      execute: async (_c: unknown, name: string) => {
        internalTools.push(name);
        return {
          ok: true,
          toolName: name,
          storeId: 'store_1',
          data: {
            results: [
              {
                id: 'p1',
                title: 'World History Vol 1',
                primaryVariantId: 'v1',
                variants: [{ id: 'v1', price: '24.99', inventoryQuantity: 8 }],
              },
            ],
          },
        };
      },
    } as never,
    {
      summarizeForPrompt: () => '',
      load: async () => ({}),
      setEmailState: async () => undefined,
    } as never,
    { mergeSessionMetadata: async () => ({}), findOneById: async () => ({ metadata: {} }) } as never,
  );

  const runtime = buildRuntime({
    handleTurn: (id, text, hist, opts) =>
      orchestrator.handleTurn(id, text, hist, { ...opts, completionFn }),
  });

  const { reply } = await runtime.processUtterance('sess_brain_2', 'I need a history book', []);
  assert.ok(internalTools.includes('searchProducts'));
  assert.match(reply, /World History/i);
  assert.match(reply, /24\.99/);
});

test('containsBannedVoicePhrase detects robotic fillers', () => {
  assert.equal(containsBannedVoicePhrase('Just a moment, let me check that.'), true);
  assert.equal(containsBannedVoicePhrase('Thank you for asking.'), true);
  assert.equal(containsBannedVoicePhrase('Sure thing, I got you.'), true);
});
