import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentRuntimePrompt } from '../calls/runtime/build-agent-runtime-prompt';
import { resolveCredentialPriority } from '../../common/credential-priority.util';

test('prompt preview for Agent A does not contain Agent B data', () => {
  const a = buildAgentRuntimePrompt({
    agentId: 'agent-a',
    agentName: 'Store Alpha Assistant',
    storeName: 'Alpha Books',
    language: 'en',
    greetingMessage: 'Welcome to Alpha Books',
    baseSystemPrompt: 'Only sell Alpha inventory.',
    restrictedActions: 'competitor stores',
    config: {
      customSystemPrompt: 'Alpha upsell policy.',
      shippingPolicy: 'Alpha ships in 2 days',
    },
  });
  const b = buildAgentRuntimePrompt({
    agentId: 'agent-b',
    agentName: 'Store Beta Assistant',
    storeName: 'Beta Books',
    language: 'en',
    greetingMessage: 'Welcome to Beta Books',
    baseSystemPrompt: 'Only sell Beta inventory.',
    restrictedActions: 'politics',
    config: {
      customSystemPrompt: 'Beta upsell policy.',
      shippingPolicy: 'Beta ships in 5 days',
    },
  });

  assert.match(a, /Alpha Books/);
  assert.match(a, /Welcome to Alpha Books/);
  assert.doesNotMatch(a, /Beta Books/);
  assert.doesNotMatch(a, /Welcome to Beta Books/);
  assert.doesNotMatch(a, /Beta upsell/);

  assert.match(b, /Beta Books/);
  assert.doesNotMatch(b, /Alpha Books/);
  assert.doesNotMatch(b, /Alpha upsell/);
});

test('email credential resolution isolates agent vs workspace keys', () => {
  const agentA = resolveCredentialPriority('re_agent_a_key', 're_workspace_key', 're_env_key');
  const agentB = resolveCredentialPriority('re_agent_b_key', 're_workspace_key', 're_env_key');
  assert.equal(agentA.value, 're_agent_a_key');
  assert.equal(agentA.source, 'agent');
  assert.equal(agentB.value, 're_agent_b_key');
  assert.notEqual(agentA.value, agentB.value);
});

test('workspace email does not apply when agent provides its own key', () => {
  const resolved = resolveCredentialPriority('agent-only-key', 'workspace-key', 'env-key');
  assert.equal(resolved.source, 'agent');
  assert.equal(resolved.value, 'agent-only-key');
});

test('runtime prompt includes production guardrails', () => {
  const prompt = buildAgentRuntimePrompt({
    agentId: 'x',
    agentName: 'A',
    storeName: 'S',
    language: 'en',
  });
  assert.match(prompt, /Never invent product names/);
  assert.match(prompt, /Never ask for card number/);
  assert.match(prompt, /retrieve knowledge or escalate; never guess/);
  assert.match(prompt, /email sending is not configured/);
});
