# Shopify store voice agent (Next.js + Twilio ConversationRelay)

This module answers inbound calls with a realtime AI assistant. Twilio handles STT/TTS via **ConversationRelay**; your Node server implements the **WebSocket** agent and loads store truth from **Postgres** (not the storefront).

## Architecture

- **`POST /api/twilio/voice/inbound`**: returns TwiML (`Say` greeting + `<Connect><ConversationRelay .../></Connect>`).
- **`GET/POST /api/twilio/voice/stream` (WebSocket upgrade)**: ConversationRelay session (setup/prompt messages in, `text` tokens out).
- **Database** (`packages/voice-db`): `store_settings`, `faq_items`, `call_logs`, `callback_bookings`.
- **Custom server** (`apps/web/server.ts`): Next.js does not expose WebSockets from Route Handlers, so dev/prod entrypoints run `tsx server.ts` to attach `ws` on the same port as Next.

## Prerequisites

- Node.js 20+
- pnpm 9+
- Postgres (a dedicated database is recommended for `VOICE_AGENT_DATABASE_URL`)
- Twilio account with Voice + **Predictive and Generative AI/ML Features Addendum** enabled (ConversationRelay requirement)
- OpenAI API key
- ngrok (or another TLS tunnel) for local Twilio testing

## Environment variables

Copy `apps/web/.env.example` → `apps/web/.env.local` and set at minimum:

| Variable | Purpose |
| --- | --- |
| `VOICE_AGENT_DATABASE_URL` | Postgres URL for Prisma (`packages/voice-db`) |
| `TWILIO_AUTH_TOKEN` | Signature validation for inbound voice + WS |
| `OPENAI_API_KEY` | LLM + tool calling |
| `VOICE_PUBLIC_BASE_URL` | Public `https://...` base used to build `wss://.../api/twilio/voice/stream` (no trailing slash) |
| `VOICE_DEFAULT_STORE_KEY` | Fallback when `To` does not match `store_settings.storeKey` |
| `VALIDATE_TWILIO_SIGNATURES` | `true` in prod; can be `false` for some local experiments |
| `VOICE_ADMIN_API_KEY` | Protects `GET/POST /api/store/settings` (if unset, settings routes are open) |

Optional:

| Variable | Purpose |
| --- | --- |
| `TWILIO_VOICE_RELAY_WS_URL` | Full override for ConversationRelay `url="wss://..."` |
| `SHOPIFY_SHOP_DOMAIN` / `SHOPIFY_ADMIN_API_TOKEN` | Global fallback for `getOrderStatus` tool |
| `TWILIO_VOICE_CONNECT_ACTION_URL` | Twilio `<Connect action="...">` callback |

## Database setup

From repo root:

```bash
pnpm install
export VOICE_AGENT_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/voice_agent" # bash/zsh
# PowerShell:
# $env:VOICE_AGENT_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/voice_agent"

pnpm db:voice:generate
pnpm db:voice:migrate
pnpm db:voice:seed
```

`prisma generate` reads `VOICE_AGENT_DATABASE_URL` from the environment (the value can be a placeholder URL for generate, but it must be present).

Note: repo-root `pnpm db:voice:generate`, `pnpm db:voice:migrate`, and `pnpm db:voice:seed` default `VOICE_AGENT_DATABASE_URL` to `postgresql://postgres:postgres@localhost:5432/voice_agent` via `cross-env` for local convenience. Override if your Postgres differs.

Alternative SQL seed (fashion demo): `docs/voice-agent-sample-seed.sql`.

The seed creates a fashion-demo store at `storeKey=demo-fashion` (override with `VOICE_SEED_STORE_KEY`).

### Map a Twilio number to a store

`store_settings.storeKey` should match the inbound Twilio `To` number (E.164), **or** you can rely on `VOICE_DEFAULT_STORE_KEY`.

Example: if your Twilio Voice number is `+15551234567`, create/update settings with `storeKey: "+15551234567"`.

## Run locally (with ngrok)

1. Start Postgres and apply migrations + seed (above).
2. Start the web server (this uses the custom server entrypoint):

```bash
pnpm --filter web dev
```

3. Start ngrok on port 3000:

```bash
ngrok http 3000
```

4. Set `VOICE_PUBLIC_BASE_URL` to your ngrok HTTPS origin (example: `https://abcd-123.ngrok-free.app`).

5. In Twilio Console → Phone Numbers → your number → Voice & Fax:

- **A call comes in**: Webhook / HTTP POST
- URL: `https://<ngrok-host>/api/twilio/voice/inbound`

6. Call the number. You should hear the greeting, then the ConversationRelay welcome prompt, then be able to talk to the assistant.

### Local testing tips

- Twilio cannot reach `http://localhost` directly; ngrok (or similar) is required.
- ConversationRelay requires **`wss://`** on the public URL. `VOICE_PUBLIC_BASE_URL` must be `https://` so the server derives `wss://`.
- If signatures fail while iterating, temporarily set `VALIDATE_TWILIO_SIGNATURES=false` (dev only).

## API: store settings CRUD

`GET /api/store/settings?storeKey=...`

`POST /api/store/settings` JSON body (upsert):

```json
{
  "storeKey": "demo-fashion",
  "storeName": "Northwind Atelier",
  "greeting": "Thanks for calling Northwind Atelier.",
  "timezone": "America/New_York",
  "hoursJson": { "monFri": "11-7" },
  "shippingPolicy": "...",
  "returnsPolicy": "...",
  "escalationPhone": "+18005550199",
  "shopifyDomain": "your-store.myshopify.com",
  "shopifyAdminToken": "shpat_...",
  "faqs": [
    { "question": "Do you ship internationally?", "answer": "...", "priority": 10 }
  ]
}
```

If `VOICE_ADMIN_API_KEY` is set, include header `x-voice-admin-key: <value>`.

## Tools (AI)

| Tool | Behavior |
| --- | --- |
| `getOrderStatus` | Calls Shopify Admin REST **only** if credentials exist; verifies caller phone digits against the order phone fields. Never invents fulfillment state. |
| `bookCallback` | Inserts `callback_bookings`. |
| `searchFAQ` | DB search over `faq_items` for the active store. |

## Production notes

- Run `pnpm --filter web build` then `pnpm --filter web start` (uses `tsx server.ts` behind your process manager).
- Terminate TLS at your edge (Caddy/Nginx) and forward to Node; set `x-forwarded-proto: https` + `x-forwarded-host` so signature validation and `wss://` URL construction stay correct.
- Keep `VALIDATE_TWILIO_SIGNATURES=true`.
- Set a strong `VOICE_ADMIN_API_KEY`.

## Troubleshooting

- **403 on inbound TwiML**: signature validation failed (URL mismatch vs Twilio’s signed URL). Align public URL headers and webhook URL.
- **WebSocket disconnect**: confirm ngrok supports websockets and that `TWILIO_VOICE_RELAY_WS_URL` / derived `wss` URL matches what Twilio connects to.
- **“not configured for this number”**: no `store_settings` row for `To` and no `VOICE_DEFAULT_STORE_KEY` match.
