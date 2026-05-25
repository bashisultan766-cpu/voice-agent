import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentRuntimePrompt, buildRuntimePromptLayers } from './build-agent-runtime-prompt';
import { PLATFORM_SAFETY_PROMPT } from './platform-runtime-prompts';

test('platform safety includes mandatory guardrails', () => {
  assert.match(PLATFORM_SAFETY_PROMPT, /Never invent product names/);
  assert.match(PLATFORM_SAFETY_PROMPT, /Never ask for card number/);
});

test('buildAgentRuntimePrompt fills agent and store names', () => {
  const prompt = buildAgentRuntimePrompt({
    agentId: 'a1',
    agentName: 'Agent A',
    storeName: 'Alpha Shop',
    language: 'en',
    greetingMessage: 'Hello from Agent A',
    baseSystemPrompt: 'Always mention free shipping.',
  });
  assert.match(prompt, /You are Agent A, a professional AI voice order booking assistant for Alpha Shop/);
  assert.match(prompt, /Always mention free shipping/);
  assert.doesNotMatch(prompt, /Agent B/);
});

test('buildAgentRuntimePrompt isolates greetings and blocked topics per agent', () => {
  const a = buildAgentRuntimePrompt({
    agentId: 'a1',
    agentName: 'Agent A',
    storeName: 'Store',
    language: 'en',
    greetingMessage: 'Hello from Agent A',
    restrictedActions: 'politics',
  });
  const b = buildAgentRuntimePrompt({
    agentId: 'b1',
    agentName: 'Agent B',
    storeName: 'Store',
    language: 'en',
    greetingMessage: 'Hello from Agent B',
    restrictedActions: 'religion',
  });
  assert.match(a, /Hello from Agent A/);
  assert.match(b, /Hello from Agent B/);
  assert.match(a, /Blocked topics: politics/);
  assert.match(b, /Blocked topics: religion/);
});

test('buildAgentRuntimePrompt includes scope guardrails', () => {
  const prompt = buildAgentRuntimePrompt({
    agentId: '1',
    agentName: 'A',
    storeName: 'S',
    language: 'en',
  });
  assert.match(prompt, /Refuse and redirect/);
  assert.match(prompt, /Never invent product names/);
  assert.match(prompt, /official Shopify checkout/);
});

test('client system prompt only appears in agent custom layer', () => {
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
  assert.doesNotMatch(layers.platformCommerce, /BASE_ONLY/);
});

test('buildAgentRuntimePrompt maps policies from config', () => {
  const prompt = buildAgentRuntimePrompt({
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
  assert.match(prompt, /Ships in 3 days/);
  assert.match(prompt, /30-day returns/);
  assert.match(prompt, /Upsell bundles when possible/);
});
