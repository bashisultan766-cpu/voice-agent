import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentRuntimePrompt, AGENT_RUNTIME_PROMPT_TEMPLATE } from './build-agent-runtime-prompt';

test('template includes required sections', () => {
  assert.match(AGENT_RUNTIME_PROMPT_TEMPLATE, /\{\{agentName\}\}/);
  assert.match(AGENT_RUNTIME_PROMPT_TEMPLATE, /\{\{customSystemPrompt\}\}/);
  assert.match(AGENT_RUNTIME_PROMPT_TEMPLATE, /Payment safety/);
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
  assert.match(a, /Blocked topics:\npolitics/);
  assert.match(b, /Blocked topics:\nreligion/);
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
