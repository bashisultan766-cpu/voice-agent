import test from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import {
  applyToolResultToState,
  emptyLlmAgentState,
  inferIntentHintFromText,
  mergeCallerSignalsIntoState,
} from './llm-agent-conversation-state.util';
import { mapLlmToolArgs, LLM_TOOL_TO_INTERNAL } from './llm-agent-tools';
import { sanitizeBannedVoicePhrases } from './professional-conversation-policy.util';
import type { ToolResult } from './tool-orchestrator.service';
import type { OpenAiCompletionFn } from './llm-agent-orchestrator.service';

function mockSearchToolResult(): ToolResult {
  return {
    ok: true,
    toolName: 'searchProducts',
    storeId: 'store_1',
    data: {
      results: [
        {
          id: 'gid://shopify/Product/1',
          title: 'World History Vol 1',
          primaryVariantId: 'gid://shopify/ProductVariant/99',
          variants: [
            {
              id: 'gid://shopify/ProductVariant/99',
              price: '24.99',
              inventoryQuantity: 8,
            },
          ],
        },
      ],
    },
  };
}

test('LLM tools map to internal runtime tools', () => {
  assert.equal(LLM_TOOL_TO_INTERNAL.ShopifyProductSearch, 'searchProducts');
  assert.equal(LLM_TOOL_TO_INTERNAL.CreatePaymentLink, 'createCheckoutLink');
  const args = mapLlmToolArgs('ShopifyProductSearch', {
    query: 'history',
    searchType: 'category',
  });
  assert.match(String(args.query), /history/i);
});

test('hello how are you intent is greeting or small_talk without requiring tools', () => {
  const hint = inferIntentHintFromText('Hello how are you');
  assert.ok(hint === 'greeting' || hint === 'small_talk');
});

test('history book utterance hints product_search', () => {
  assert.equal(inferIntentHintFromText('I need a history book'), 'product_search');
});

test('search tool updates state with title price stock', () => {
  let state = emptyLlmAgentState();
  state = applyToolResultToState(state, 'ShopifyProductSearch', mockSearchToolResult());
  assert.equal(state.lastSearchedProducts.length, 1);
  assert.match(state.lastSearchedProducts[0]!.title, /World History/i);
  assert.equal(state.lastSearchedProducts[0]!.price, '24.99');
  assert.equal(state.lastSearchedProducts[0]!.stock, 8);
});

test('first one selection intent hint', () => {
  assert.equal(inferIntentHintFromText('I want the first one'), 'product_selected');
});

test('quantity merges into state', () => {
  let state = emptyLlmAgentState();
  state.lastSearchedProducts = [
    { title: 'World History Vol 1', variantId: 'var_99', price: '24.99', stock: 8 },
  ];
  state = mergeCallerSignalsIntoState(state, { quantity: 2 });
  assert.equal(state.quantities['var_99'], 2);
  assert.equal(state.checkoutStage, 'quantity');
});

test('email merges into state', () => {
  let state = emptyLlmAgentState();
  state = mergeCallerSignalsIntoState(state, { email: 'buyer@example.com' });
  assert.equal(state.customerEmail, 'buyer@example.com');
  assert.equal(state.checkoutStage, 'email');
});

test('mocked OpenAI turn: greeting has no tool calls', async () => {
  const { LlmAgentOrchestratorService } = await import('./llm-agent-orchestrator.service');
  const toolCalls: string[] = [];
  const completionFn: OpenAiCompletionFn = async () =>
    ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: "I'm doing well, thanks. What book can I help you find today?",
          },
        },
      ],
    }) as OpenAI.Chat.ChatCompletion;

  const orchestrator = new LlmAgentOrchestratorService(
    { get: () => undefined } as never,
    {
      load: async () =>
        ({
          tenantId: 't1',
          agentId: 'a1',
          storeId: 's1',
          fromNumber: '+15551234567',
          metadata: {},
          agent: {
            openaiApiKey: 'sk-test-key-1234567890',
            model: 'gpt-4o-mini',
            enabledTools: ['searchProducts', 'createCheckoutLink', 'sendPaymentEmail'],
            toolPermissions: null,
            runtimeCredentialHints: { openaiKeySource: 'test' },
          },
          store: { name: 'SureShot Books' },
        }) as never,
    } as never,
    {
      execute: async (_ctx: unknown, name: string) => {
        toolCalls.push(name);
        return mockSearchToolResult();
      },
    } as never,
    {
      summarizeForPrompt: () => '',
      load: async () => ({}),
      setEmailState: async () => undefined,
    } as never,
    { mergeSessionMetadata: async () => ({}) } as never,
  );

  const out = await orchestrator.processTurn('sess_1', 'Hello how are you', [], {
    completionFn,
  });
  assert.equal(toolCalls.length, 0);
  assert.match(out.reply, /book/i);
  assert.doesNotMatch(out.reply, /go ahead/i);
  assert.doesNotMatch(out.reply, /dropship/i);
  assert.doesNotMatch(out.reply, /i am an ai/i);
});

test('mocked OpenAI turn: history book triggers ShopifyProductSearch', async () => {
  const { LlmAgentOrchestratorService } = await import('./llm-agent-orchestrator.service');
  let step = 0;
  const completionFn: OpenAiCompletionFn = async () => {
    step += 1;
    if (step === 1) {
      return {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
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
              'I found World History Vol 1 for $24.99 with 8 copies in stock. Would you like to order it?',
          },
        },
      ],
    } as OpenAI.Chat.ChatCompletion;
  };

  const internalTools: string[] = [];
  const orchestrator = new LlmAgentOrchestratorService(
    { get: () => undefined } as never,
    {
      load: async () =>
        ({
          tenantId: 't1',
          agentId: 'a1',
          storeId: 's1',
          fromNumber: '+15551234567',
          metadata: {},
          agent: {
            openaiApiKey: 'sk-test-key-1234567890',
            model: 'gpt-4o-mini',
            enabledTools: ['searchProducts', 'createCheckoutLink', 'sendPaymentEmail', 'get_order_status'],
            toolPermissions: null,
            runtimeCredentialHints: { openaiKeySource: 'test' },
          },
          store: { name: 'SureShot Books' },
        }) as never,
    } as never,
    {
      execute: async (_ctx: unknown, name: string) => {
        internalTools.push(name);
        return mockSearchToolResult();
      },
    } as never,
    {
      summarizeForPrompt: () => '',
      load: async () => ({}),
      setEmailState: async () => undefined,
    } as never,
    { mergeSessionMetadata: async () => ({}) } as never,
  );

  const out = await orchestrator.processTurn('sess_2', 'I need a history book', [], {
    completionFn,
  });
  assert.ok(internalTools.includes('searchProducts'));
  assert.match(out.reply, /World History/i);
  assert.match(out.reply, /\$24\.99|24\.99/);
  assert.match(out.reply, /8/);
  for (const phrase of ['go ahead', 'dropshipping', 'i am an ai']) {
    assert.doesNotMatch(out.reply.toLowerCase(), new RegExp(phrase, 'i'));
  }
});

test('banned phrase sanitizer strips go ahead and dropshipping', () => {
  assert.doesNotMatch(sanitizeBannedVoicePhrases('Go ahead and tell me.'), /go ahead/i);
  assert.doesNotMatch(sanitizeBannedVoicePhrases('We offer dropshipping.'), /dropship/i);
});
