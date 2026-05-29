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
    { mergeSessionMetadata: async () => ({}), findOneById: async () => ({ metadata: {} }) } as never,
  );

  const out = await orchestrator.handleTurn('sess_1', 'Hello how are you', [], {
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
    { mergeSessionMetadata: async () => ({}), findOneById: async () => ({ metadata: {} }) } as never,
  );

  const out = await orchestrator.handleTurn('sess_2', 'I need a history book', [], {
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

test('email confirmation auto-runs checkout and sendPaymentEmail without LLM', async () => {
  const { LlmAgentOrchestratorService } = await import('./llm-agent-orchestrator.service');
  const internalTools: string[] = [];
  let openAiCalls = 0;
  let memoryState: Record<string, unknown> = {};
  let sessionMetadata: Record<string, unknown> = { emailRetryCount: 0, emailSendFailureCount: 0 };

  const completionFn: OpenAiCompletionFn = async () => {
    openAiCalls += 1;
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Thanks, I have your email.',
          },
        },
      ],
    } as OpenAI.Chat.ChatCompletion;
  };

  const orchestrator = new LlmAgentOrchestratorService(
    { get: () => undefined } as never,
    {
      load: async () =>
        ({
          tenantId: 't1',
          agentId: 'a1',
          storeId: 's1',
          fromNumber: '+15551234567',
          metadata: {
            llmAgentState: {
              selectedProducts: [
                {
                  title: 'World History Vol 1',
                  variantId: 'gid://shopify/ProductVariant/99',
                  inStock: true,
                  stock: 8,
                },
              ],
              quantities: { 'gid://shopify/ProductVariant/99': 2 },
              checkoutStage: 'quantity',
              customerEmail: memoryState.collectedEmail ?? null,
              lastSearchedProducts: [],
              lastToolCalls: [],
            },
          },
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
        internalTools.push(name);
        if (name === 'createCheckoutLink') {
          return {
            ok: true,
            toolName: name,
            storeId: 's1',
            data: {
              checkoutLinkId: 'chk_auto_1',
              checkoutUrl: 'https://demo.myshopify.com/cart/abc',
              mode: 'STOREFRONT_CART',
            },
          };
        }
        if (name === 'sendPaymentEmail') {
          return {
            ok: true,
            toolName: name,
            storeId: 's1',
            data: { voiceSummary: 'Email sent.' },
          };
        }
        return { ok: false, toolName: name, storeId: 's1', error: { code: 'UNEXPECTED', message: 'n/a', retryable: false } };
      },
    } as never,
    {
      summarizeForPrompt: () => '',
      load: async () => memoryState,
      setEmailState: async (_id: string, email: string, state: 'pending' | 'confirmed') => {
        memoryState = {
          collectedEmail: email,
          emailConfirmationState: state,
          emailCollected: state === 'confirmed',
        };
      },
    } as never,
    {
      findOneById: async () => ({ metadata: sessionMetadata }),
      mergeSessionMetadata: async (_id: string, patch: Record<string, unknown>) => {
        sessionMetadata = { ...sessionMetadata, ...patch };
        return {};
      },
    } as never,
  );

  const capture = await orchestrator.handleTurn('sess_checkout_auto', 'oishisultan766@gmail.com', [], {
    completionFn,
  });
  assert.equal(openAiCalls, 0, 'OpenAI should not run on email capture');
  assert.equal(internalTools.length, 0, 'Checkout must wait for confirmation');
  assert.match(capture.reply, /Just to confirm, your email is oishisultan766@gmail.com/i);

  const confirmed = await orchestrator.handleTurn('sess_checkout_auto', 'yes that is correct', [], {
    completionFn,
  });
  assert.equal(openAiCalls, 0, 'OpenAI should not run when auto-checkout handles confirmation');
  assert.ok(internalTools.includes('createCheckoutLink'));
  assert.ok(internalTools.includes('sendPaymentEmail'));
  assert.match(confirmed.reply, /sent successfully/i);
  assert.match(confirmed.reply, /check your inbox/i);
  assert.equal(confirmed.state.paymentLinkCreated, true);
  assert.equal(confirmed.state.paymentLinkSent, true);
  assert.equal(confirmed.state.checkoutStage, 'payment_sent');
  assert.equal(confirmed.toolCallsCount, 2);
});

test('transactional checkout: product selected with quantity forces deterministic email prompt without OpenAI', async () => {
  const { LlmAgentOrchestratorService } = await import('./llm-agent-orchestrator.service');
  let openAiCalls = 0;

  const completionFn: OpenAiCompletionFn = async () => {
    openAiCalls += 1;
    return {
      choices: [{ message: { role: 'assistant', content: 'Please share your email address.' } }],
    } as OpenAI.Chat.ChatCompletion;
  };

  const orchestrator = new LlmAgentOrchestratorService(
    { get: () => undefined } as never,
    {
      load: async () =>
        ({
          tenantId: 't1',
          agentId: 'a1',
          storeId: 's1',
          fromNumber: '+15551234567',
          metadata: {
            llmAgentState: {
              selectedProducts: [
                {
                  title: 'World History Vol 1',
                  variantId: 'gid://shopify/ProductVariant/99',
                  inStock: true,
                  stock: 8,
                },
              ],
              quantities: { 'gid://shopify/ProductVariant/99': 2 },
              checkoutStage: 'product_selected',
              customerEmail: null,
              lastSearchedProducts: [],
              lastToolCalls: [],
            },
          },
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
    { execute: async () => ({ ok: false, toolName: 'n/a', storeId: 's1', error: { code: 'UNEXPECTED', message: 'n/a', retryable: false } }) } as never,
    {
      summarizeForPrompt: () => '',
      load: async () => ({}),
      setEmailState: async () => undefined,
    } as never,
    {
      findOneById: async () => ({ metadata: { emailRetryCount: 0 } }),
      mergeSessionMetadata: async () => ({}),
    } as never,
  );

  const out = await orchestrator.handleTurn('sess_tx_email', 'yes I want to order', [], { completionFn });

  assert.equal(openAiCalls, 0);
  assert.equal(out.proof?.openaiCalled, false);
  assert.equal(out.proof?.transactionalMode, true);
  assert.equal(out.proof?.skipOpenAiGeneration, true);
  assert.equal(out.proof?.deterministicReplyUsed, true);
  assert.match(out.reply, /Perfect\. Please spell your email address slowly/i);
  assert.doesNotMatch(out.reply, /share your email/i);
  assert.equal(out.state.transactionalCheckoutState, 'EMAIL_COLLECTION_REQUIRED');
});

test('transactional checkout: product selected without quantity forces quantity prompt without OpenAI', async () => {
  const { LlmAgentOrchestratorService } = await import('./llm-agent-orchestrator.service');
  let openAiCalls = 0;

  const orchestrator = new LlmAgentOrchestratorService(
    { get: () => undefined } as never,
    {
      load: async () =>
        ({
          tenantId: 't1',
          agentId: 'a1',
          storeId: 's1',
          fromNumber: '+15551234567',
          metadata: {
            llmAgentState: {
              selectedProducts: [
                {
                  title: 'World History Vol 1',
                  variantId: 'gid://shopify/ProductVariant/99',
                  inStock: true,
                  stock: 8,
                },
              ],
              checkoutStage: 'product_selected',
              customerEmail: null,
              lastSearchedProducts: [],
              lastToolCalls: [],
              quantities: {},
            },
          },
          agent: {
            openaiApiKey: 'sk-test-key-1234567890',
            model: 'gpt-4o-mini',
            enabledTools: ['searchProducts'],
            runtimeCredentialHints: { openaiKeySource: 'test' },
          },
          store: { name: 'SureShot Books' },
        }) as never,
    } as never,
    { execute: async () => ({ ok: false, toolName: 'n/a', storeId: 's1', error: { code: 'UNEXPECTED', message: 'n/a', retryable: false } }) } as never,
    {
      summarizeForPrompt: () => '',
      load: async () => ({}),
      setEmailState: async () => undefined,
    } as never,
    {
      findOneById: async () => ({ metadata: {} }),
      mergeSessionMetadata: async () => ({}),
    } as never,
  );

  const out = await orchestrator.handleTurn(
    'sess_tx_qty',
    'yes the first one',
    [],
    {
      completionFn: async () => {
        openAiCalls += 1;
        return { choices: [{ message: { role: 'assistant', content: 'How many?' } }] } as OpenAI.Chat.ChatCompletion;
      },
    },
  );

  assert.equal(openAiCalls, 0);
  assert.match(out.reply, /How many copies/i);
  assert.equal(out.proof?.transactionalCheckoutState, 'QUANTITY_COLLECTION_REQUIRED');
});

test('production log: yeah just one copy for this locks checkout without OpenAI', async () => {
  const { LlmAgentOrchestratorService } = await import('./llm-agent-orchestrator.service');
  let openAiCalls = 0;

  const completionFn: OpenAiCompletionFn = async () => {
    openAiCalls += 1;
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: "I'll prepare the payment link right away. Please share your email address.",
          },
        },
      ],
    } as OpenAI.Chat.ChatCompletion;
  };

  const orchestrator = new LlmAgentOrchestratorService(
    { get: () => undefined } as never,
    {
      load: async () =>
        ({
          tenantId: 't1',
          agentId: 'a1',
          storeId: 's1',
          fromNumber: '+15551234567',
          metadata: {
            llmAgentState: {
              selectedProducts: [],
              lastSearchedProducts: [
                {
                  title: 'World History Vol 1',
                  variantId: 'gid://shopify/ProductVariant/99',
                  inStock: true,
                  stock: 8,
                  price: '24.99',
                },
              ],
              quantities: {},
              checkoutStage: 'product_discovery',
              customerIntent: 'product_search',
              lastToolCalls: ['ShopifyProductSearch'],
            },
          },
          agent: {
            openaiApiKey: 'sk-test-key-1234567890',
            model: 'gpt-4o-mini',
            enabledTools: ['searchProducts', 'createCheckoutLink', 'sendPaymentEmail'],
            runtimeCredentialHints: { openaiKeySource: 'test' },
          },
          store: { name: 'SureShot Books' },
        }) as never,
    } as never,
    { execute: async () => ({ ok: false, toolName: 'n/a', storeId: 's1', error: { code: 'UNEXPECTED', message: 'n/a', retryable: false } }) } as never,
    {
      summarizeForPrompt: () => '',
      load: async () => ({}),
      setEmailState: async () => undefined,
    } as never,
    {
      findOneById: async () => ({ metadata: { emailRetryCount: 0 } }),
      mergeSessionMetadata: async () => ({}),
    } as never,
  );

  const out = await orchestrator.handleTurn(
    'sess_prod_log',
    'yeah just one copy for this',
    [],
    { completionFn },
  );

  assert.equal(openAiCalls, 0);
  assert.equal(out.proof?.openaiCalled, false);
  assert.equal(out.proof?.transactionalMode, true);
  assert.equal(out.proof?.skipOpenAiGeneration, true);
  assert.equal(out.state.checkoutStage, 'email');
  assert.equal(out.state.customerIntent, 'email_collection');
  assert.notEqual(out.state.checkoutStage, 'product_discovery');
  assert.notEqual(out.state.customerIntent, 'product_search');
  assert.match(out.reply, /Perfect\. Please spell your email address slowly/i);
  assert.doesNotMatch(out.reply, /share your email/i);
  assert.doesNotMatch(out.reply, /prepare the payment link/i);
});
