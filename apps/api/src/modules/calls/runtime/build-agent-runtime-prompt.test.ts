import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentRuntimePrompt,
  buildEnterpriseRuntimePromptLayers,
  buildRuntimePromptLayers,
} from './build-agent-runtime-prompt';
import { PLATFORM_LAYER_PROMPT } from './platform-runtime-prompts';

test('platform layer includes mandatory guardrails', () => {
  assert.match(PLATFORM_LAYER_PROMPT, /Never invent product names/);
  assert.match(PLATFORM_LAYER_PROMPT, /Never ask for card number/);
  assert.match(PLATFORM_LAYER_PROMPT, /No medical, legal, or financial advice/);
});

test('buildAgentRuntimePrompt fills agent identity and store names', () => {
  const prompt = buildAgentRuntimePrompt({
    agentId: 'a1',
    agentName: 'Agent A',
    storeName: 'Alpha Shop',
    language: 'en',
    greetingMessage: 'Hello from Agent A',
    baseSystemPrompt: 'Be warm and concise.',
  });
  assert.match(prompt, /voice assistant for Alpha Shop/);
  assert.match(prompt, /Be warm and concise/);
  assert.doesNotMatch(prompt, /Agent B/);
});

test('policies are not inlined in identity layer', () => {
  const layers = buildEnterpriseRuntimePromptLayers({
    agentId: '1',
    agentName: 'A',
    storeName: 'S',
    language: 'en',
    config: {
      shippingPolicy: 'Ships in 3 days',
      returnPolicy: '30-day returns',
      customSystemPrompt: 'Upsell bundles when possible.',
    },
  });
  assert.match(layers.agentIdentity, /Upsell bundles when possible/);
  assert.doesNotMatch(layers.agentIdentity, /Ships in 3 days/);
  assert.doesNotMatch(layers.agentIdentity, /30-day returns/);
  assert.match(layers.storePolicyKnowledge, /retrieval-only/);
  assert.match(layers.storePolicyKnowledge, /retrieve_knowledge_base/);
});

test('client identity text only in agent identity layer', () => {
  const layers = buildRuntimePromptLayers({
    agentId: '1',
    agentName: 'A',
    storeName: 'S',
    language: 'en',
    baseSystemPrompt: 'BASE_ONLY',
    config: { customSystemPrompt: 'CLIENT_ONLY' },
  });
  assert.match(layers.agentCustom, /CLIENT_ONLY/);
  assert.doesNotMatch(layers.platformSafety, /CLIENT_ONLY/);
});

test('shopify truth layer is separate', () => {
  const layers = buildEnterpriseRuntimePromptLayers({
    agentId: '1',
    agentName: 'A',
    storeName: 'S',
    language: 'en',
  });
  assert.match(layers.shopifyTruth, /ONLY from Shopify tools/);
});

test('policy retrieval layer includes prefetch snapshot', () => {
  const layers = buildEnterpriseRuntimePromptLayers(
    { agentId: '1', agentName: 'A', storeName: 'S', language: 'en' },
    {
      policyRetrievalRequired: true,
      policyTopic: 'refund',
      knowledgeRetrievalSnapshot: '[Refund] 30-day returns on unopened books.',
    },
  );
  assert.match(layers.knowledgeRetrieval, /30-day returns/);
  assert.match(layers.knowledgeRetrieval, /refund/);
});

test('prompt budget warns on oversized identity', () => {
  const big = 'x'.repeat(5000);
  const layers = buildEnterpriseRuntimePromptLayers({
    agentId: '1',
    agentName: 'A',
    storeName: 'S',
    language: 'en',
    baseSystemPrompt: big,
  });
  assert.ok(layers.budget.warnings.length > 0);
  assert.equal(layers.budget.recommendKnowledgeBase, true);
});
