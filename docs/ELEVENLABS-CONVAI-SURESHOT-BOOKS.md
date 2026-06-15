# ElevenLabs ConvAI — SureShot Books purchase flow

Configure the ElevenLabs Conversational AI agent for Twilio inbound (`POST /api/elevenlabs/inbound`).

## Quick setup

1. Fetch agent config from your API (after deploy):

   `GET https://<your-host>/api/elevenlabs/convai/agent-config`

2. Copy `systemPrompt` into the ElevenLabs agent **System prompt**.
3. Set **First message** to the `openingLine` from the config.
4. Add **Server tools** (names must match exactly):

| Tool name | Method | URL |
|-----------|--------|-----|
| `SureShotBooksProduct` | POST | `https://<your-host>/api/voice/search-product` |
| `SureShotBooksProductFetcher` | GET | `https://<your-host>/api/voice/get-product` |
| `SendPaymentLink` | POST | `https://<your-host>/api/voice/send-payment-link` |

5. If `VOICE_COMMERCE_API_KEY` is set, add header `x-voice-api-key` on all voice tools in ElevenLabs.

## Purchase flow (mandatory)

When the customer confirms they want to buy:

1. Use the **selected product** from the latest `SureShotBooksProduct` result.
2. Keep **`variantId`** from that result (do not guess).
3. Ask for **email**.
4. **Repeat email back** and wait for confirmation.
5. After confirmation, **always** call `SendPaymentLink` with `email`, `variantId`, `quantity`.
6. Never end the turn before calling `SendPaymentLink`.
7. On `success: true`, say: **"I've sent the payment link to your email."** (also returned as `agentMessage`).

## Tool bodies

**SureShotBooksProduct**

```json
{ "query": "Atomic Habits", "limit": 5 }
```

**SureShotBooksProductFetcher** (query parameters on GET)

| Param | Required | Example |
|-------|----------|---------|
| `query` | One of query/isbn/sku | `Atomic Habits` |
| `isbn` | alias | `9780143127550` |
| `limit` | no | `5` |

Example URL: `GET .../api/voice/get-product?query=9780143127550&limit=5`

**SendPaymentLink** — single book

```json
{
  "email": "customer@gmail.com",
  "variantId": "gid://shopify/ProductVariant/48502554689773",
  "quantity": 1,
  "finalizeCheckout": true,
  "callSid": "{{call_sid}}",
  "phoneNumber": "{{caller_phone}}"
}
```

**SendPaymentLink** — multiple books (one email, one invoice)

1. For each book (same email): `finalizeCheckout: false` + `variantId` or `productName` + `quantity`
2. When done: `finalizeCheckout: true` + same `email` (product fields optional)

```json
{ "email": "customer@gmail.com", "variantId": "gid://shopify/ProductVariant/111", "quantity": 1, "finalizeCheckout": false, "callSid": "{{call_sid}}", "phoneNumber": "{{caller_phone}}" }
{ "email": "customer@gmail.com", "variantId": "gid://shopify/ProductVariant/222", "quantity": 1, "finalizeCheckout": false, "callSid": "{{call_sid}}", "phoneNumber": "{{caller_phone}}" }
{ "email": "customer@gmail.com", "emailConfirmed": true, "finalizeCheckout": true, "callSid": "{{call_sid}}", "phoneNumber": "{{caller_phone}}" }
```

In the ElevenLabs **SendPaymentLink** tool, set constant body fields (recommended):

| Field | Constant value |
|-------|----------------|
| `callSid` | `{{call_sid}}` or `{{system__call_sid}}` |
| `phoneNumber` | `{{caller_phone}}` or `{{system__caller_id}}` |

`POST /api/elevenlabs/inbound` stores `CallSid` + caller phone in the `calls` table and passes `call_sid` / `caller_phone` to ElevenLabs via `register-call`.

**Twilio call status (recommended for disconnect debugging):** set **Call status changes** on the Twilio number to:

`POST https://<your-host>/api/elevenlabs/call-status`

(or `https://<your-host>/api/twilio/voice/status` — both record diagnostics).

After a call, inspect: `GET https://<your-host>/api/voice/call-diagnostics/<CallSid>` (requires `x-voice-api-key` when `VOICE_COMMERCE_API_KEY` is set).

Delivery uses **Shopify invoice email + Resend backup**. SMS/WhatsApp use `phoneNumber` or lookup by `callSid`.

## Source of truth

Prompt and tool specs live in:

`apps/api/src/modules/integrations/elevenlabs/elevenlabs-convai-sureshot.config.ts`

Update that file when changing agent behavior, then refresh the ElevenLabs dashboard from `GET /api/elevenlabs/convai/agent-config`.
