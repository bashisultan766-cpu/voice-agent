import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ELEVENLABS_CONVAI_SYSTEM_PROMPT,
  ELEVENLABS_CONVAI_TOOLS,
  buildElevenLabsConvaiAgentConfig,
} from './elevenlabs-convai-sureshot.config';

test('convai system prompt references SureShotBooksProduct and SendPaymentLink', () => {
  assert.match(ELEVENLABS_CONVAI_SYSTEM_PROMPT, new RegExp(ELEVENLABS_CONVAI_TOOLS.productSearch));
  assert.match(ELEVENLABS_CONVAI_SYSTEM_PROMPT, new RegExp(ELEVENLABS_CONVAI_TOOLS.sendPaymentLink));
  assert.match(ELEVENLABS_CONVAI_SYSTEM_PROMPT, /Never stop before calling SendPaymentLink/i);
  assert.match(ELEVENLABS_CONVAI_SYSTEM_PROMPT, /I've sent the payment link to your email/i);
});

test('buildElevenLabsConvaiAgentConfig wires voice API tool URLs', () => {
  const cfg = buildElevenLabsConvaiAgentConfig('https://voice.example.com');
  assert.equal(cfg.tools.length, 3);
  assert.ok(cfg.tools.some((t) => t.url.includes('/api/voice/search-product')));
  assert.ok(cfg.tools.some((t) => t.url.includes('/api/voice/get-product')));
  assert.ok(cfg.tools.some((t) => t.url.includes('/api/voice/send-payment-link')));
});
