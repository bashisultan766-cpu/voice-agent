import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ELEVENLABS_ERIC_SYSTEM_PROMPT,
  ELEVENLABS_ERIC_TOOLS,
  buildElevenLabsEricAgentConfig,
} from './elevenlabs-convai-eric.config';

test('Eric system prompt requires GetCallerInfo on every inbound call', () => {
  assert.match(ELEVENLABS_ERIC_SYSTEM_PROMPT, new RegExp(ELEVENLABS_ERIC_TOOLS.getCallerInfo));
  assert.match(ELEVENLABS_ERIC_SYSTEM_PROMPT, /never invent caller names/i);
});

test('buildElevenLabsEricAgentConfig wires 3CX voice tools', () => {
  const cfg = buildElevenLabsEricAgentConfig('https://voice.example.com');
  assert.equal(cfg.tools.length, 2);
  assert.ok(cfg.tools.some((t) => t.url.includes('/api/voice/get-caller-info')));
  assert.ok(cfg.tools.some((t) => t.url.includes('/api/voice/save-caller-name')));
  assert.ok(cfg.dynamicVariables.recording_urls_json);
  assert.ok(cfg.toolBodyConstants?.getCallerInfo.phone_number.includes('caller_phone'));
});
