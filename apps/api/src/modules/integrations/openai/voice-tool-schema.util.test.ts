import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_AGENT_TOOLS } from './types/tool-definitions';
import {
  assertAllVoiceAgentToolSchemasValid,
  assertVoiceToolParametersValid,
  normalizeOpenAiChatCompletionsModel,
} from './voice-tool-schema.util';

test('all bundled voice agent tools satisfy OpenAI array schema rules', () => {
  assertAllVoiceAgentToolSchemasValid(VOICE_AGENT_TOOLS);
});

test('sendPaymentEmail parameters include items.items for line objects', () => {
  const def = VOICE_AGENT_TOOLS.find((t) => t.name === 'sendPaymentEmail');
  assert(def);
  const items = (def.parameters.properties as Record<string, unknown>).items as Record<string, unknown>;
  assert.equal(items.type, 'array');
  assert.ok(items.items && typeof items.items === 'object');
  const elem = items.items as Record<string, unknown>;
  assert.equal(elem.type, 'object');
  assert.ok(Array.isArray(elem.required) && (elem.required as string[]).includes('title'));
});

test('assertVoiceToolParametersValid rejects array without items', () => {
  assert.throws(
    () =>
      assertVoiceToolParametersValid('bad', {
        type: 'object',
        additionalProperties: false,
        properties: { x: { type: 'array' } },
      }),
    /array schema missing required "items"/,
  );
});

test('normalizeOpenAiChatCompletionsModel maps realtime ids to gpt-4o-mini', () => {
  assert.equal(normalizeOpenAiChatCompletionsModel('gpt-realtime'), 'gpt-4o-mini');
  assert.equal(normalizeOpenAiChatCompletionsModel('gpt-4o-realtime-preview'), 'gpt-4o-mini');
  assert.equal(normalizeOpenAiChatCompletionsModel('gpt-4o-mini'), 'gpt-4o-mini');
  assert.equal(normalizeOpenAiChatCompletionsModel(''), 'gpt-4o-mini');
  assert.equal(normalizeOpenAiChatCompletionsModel(null), 'gpt-4o-mini');
});
