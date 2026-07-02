# SureShot Books — Order Lookup Voice Agent

Focused TypeScript service for inbound order-status phone calls.

## Flow

```
Twilio inbound call
  → POST /voice/twilio/inbound (TwiML + ConversationRelay)
  → WebSocket /voice/twilio/ws
  → Order agent (OpenAI extraction + Shopify lookup)
  → Streamed text tokens → Twilio TTS (ElevenLabs Eric)
```

## Quick start

```powershell
cd services/order-lookup-voice-agent
npm install
copy .env.example .env
# Edit .env — set PUBLIC_BASE_URL to your ngrok HTTPS URL

npm run dev
```

Twilio voice webhook: `https://<host>/voice/twilio/inbound` (POST)

## Architecture

```
src/
  voice/
    twilioWebhook.ts   — inbound TwiML + relay action
    streamHandler.ts   — ConversationRelay WebSocket session
  agents/
    orderAgent.ts      — call-state machine + lookup orchestration
    prompt.ts          — LLM system prompts
  services/
    shopifyService.ts  — Shopify Admin REST order fetch + cache
    llmService.ts      — order extraction + speech polish
    voiceService.ts    — ElevenLabs + relay streaming helpers
  utils/
    formatter.ts       — deterministic voice scripts (no hallucination)
    security.ts        — PII filtering rules
  types/
    order.ts
```

## Security

- Never exposes full card numbers — last 4 only
- Email disclosed only when order is refunded
- Raw Shopify payloads are redacted in logs
- Order speech is built from API data first; LLM polish is fact-checked

## Conversational voice (streaming)

The order agent uses **chunked streaming** for human-like latency:

- `agents/responsePlanner.ts` — short-sentence speech plan (confirmation → summary → refund → payment → closing)
- `streamAgentTurn()` — yields chunks immediately; filler plays before Shopify returns
- Parallel prefetch: Shopify lookup + background LLM warm-up
- Twilio ConversationRelay receives one sentence per token (`last: false` until done)

Target perceived delay: **<800ms** to first spoken chunk after order number detected.

## Tests

```powershell
npm test
```

Covers valid order script, invalid order retry, refund cases, missing refund data, and API fallback copy.
