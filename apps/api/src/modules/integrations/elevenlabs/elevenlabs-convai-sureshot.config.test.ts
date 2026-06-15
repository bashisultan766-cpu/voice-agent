import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ELEVENLABS_CONVAI_AGENT_NAME,
  ELEVENLABS_CONVAI_OPENING_LINE,
  ELEVENLABS_CONVAI_PUBLIC_BASE_URL,
  ELEVENLABS_CONVAI_SYSTEM_PROMPT,
  ELEVENLABS_CONVAI_TOOLS,
  ELEVENLABS_CONVAI_EXPECTED_TOOL_COUNT,
  buildElevenLabsConvaiAgentConfig,
} from './elevenlabs-convai-sureshot.config';

const PRODUCTION_BASE = 'https://agent.mailcallcommunication.com';

test('agent config uses Eric branding', () => {
  assert.match(ELEVENLABS_CONVAI_AGENT_NAME, /Eric/i);
  assert.match(ELEVENLABS_CONVAI_OPENING_LINE, /Eric/i);
  assert.match(ELEVENLABS_CONVAI_OPENING_LINE, /SureShot Books/i);
  assert.doesNotMatch(ELEVENLABS_CONVAI_AGENT_NAME, /Justin/i);
  assert.doesNotMatch(ELEVENLABS_CONVAI_OPENING_LINE, /Justin/i);
});

test('system prompt uses Eric and excludes Justin and processing fee', () => {
  assert.match(ELEVENLABS_CONVAI_SYSTEM_PROMPT, /You are Eric/i);
  assert.doesNotMatch(ELEVENLABS_CONVAI_SYSTEM_PROMPT, /Justin/i);
  assert.match(ELEVENLABS_CONVAI_SYSTEM_PROMPT, /NEVER mention.*processing fee/i);
  assert.match(ELEVENLABS_CONVAI_SYSTEM_PROMPT, /subtotal before shipping/i);
  assert.match(ELEVENLABS_CONVAI_SYSTEM_PROMPT, new RegExp(ELEVENLABS_CONVAI_TOOLS.catalogSearch));
  assert.match(ELEVENLABS_CONVAI_SYSTEM_PROMPT, new RegExp(ELEVENLABS_CONVAI_TOOLS.getOrder));
  assert.match(ELEVENLABS_CONVAI_SYSTEM_PROMPT, new RegExp(ELEVENLABS_CONVAI_TOOLS.checkFacilityApproval));
  assert.match(ELEVENLABS_CONVAI_SYSTEM_PROMPT, new RegExp(ELEVENLABS_CONVAI_TOOLS.cancelOrder));
  assert.doesNotMatch(ELEVENLABS_CONVAI_SYSTEM_PROMPT, /SureShotBooksProduct/i);
});

test('buildElevenLabsConvaiAgentConfig returns 13 tools with production URLs', () => {
  const cfg = buildElevenLabsConvaiAgentConfig(PRODUCTION_BASE);

  assert.equal(cfg.tools.length, ELEVENLABS_CONVAI_EXPECTED_TOOL_COUNT);
  assert.equal(cfg.agentName, 'Eric — SureShot Books');
  assert.equal(cfg.openingLine, ELEVENLABS_CONVAI_OPENING_LINE);

  const toolNames = cfg.tools.map((t) => t.name);
  assert.ok(toolNames.includes('GetOrder'));
  assert.ok(toolNames.includes('CalculatePricing'));
  assert.ok(toolNames.includes('CheckFacilityApproval'));
  assert.ok(toolNames.includes('CancelOrderRequest'));
  assert.ok(toolNames.includes('NormalizeVoiceIntent'));
  assert.ok(toolNames.includes('SureShotCatalogSearch'));
  assert.ok(toolNames.includes('SendFacilityPaymentLink'));
  assert.ok(toolNames.includes('SendPaymentLink'));
  assert.ok(toolNames.includes('GetCallerInfo'));
  assert.ok(toolNames.includes('SaveCallerName'));
  assert.ok(!toolNames.includes('SureShotBooksProduct'));
  assert.ok(!toolNames.includes('SureShotBooksProductFetcher'));

  for (const tool of cfg.tools) {
    assert.ok(tool.url.startsWith(PRODUCTION_BASE), `Expected production URL for ${tool.name}`);
    assert.ok(tool.url.includes('/api/voice/'), `Expected /api/voice/ path for ${tool.name}`);
  }

  assert.ok(cfg.tools.some((t) => t.url === `${PRODUCTION_BASE}/api/voice/get-order`));
  assert.ok(cfg.tools.some((t) => t.url === `${PRODUCTION_BASE}/api/voice/calculate-pricing`));
  assert.ok(cfg.tools.some((t) => t.url === `${PRODUCTION_BASE}/api/voice/check-facility-approval`));
  assert.ok(cfg.tools.some((t) => t.url === `${PRODUCTION_BASE}/api/voice/cancel-order-request`));
  assert.ok(cfg.tools.some((t) => t.url === `${PRODUCTION_BASE}/api/voice/normalize-intent`));
  assert.ok(cfg.tools.some((t) => t.url === `${PRODUCTION_BASE}/api/voice/facility-payment-link`));
});

test('default public base URL constant is production host', () => {
  assert.equal(ELEVENLABS_CONVAI_PUBLIC_BASE_URL, PRODUCTION_BASE);
  const cfg = buildElevenLabsConvaiAgentConfig();
  assert.ok(cfg.tools[0]?.url.startsWith(PRODUCTION_BASE));
});
