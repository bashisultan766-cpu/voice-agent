# ShoreShot Bookstore Voice Agent

Production AI phone agent for SureShot Books. Inbound Twilio calls use **ConversationRelay** (managed STT/TTS). This repo’s sole live service is a **Node.js / TypeScript** agent that orchestrates **OpenAI**, calls **Shopify Admin API** tools through a unified Zod-validated registry, sends email via **Resend**, and persists call sessions in **Postgres**.

## Architecture

```
Twilio phone call (+12512554549)
    → POST /conversationBrain/inbound
    → order-lookup-voice-agent (Node 20+, port 8001, PM2)
    → ConversationRelay + Eric voice
    → UnifiedCallSession (L1 memory + L2 Postgres)
    → UnifiedToolRegistry → Shopify / Resend
```

**Production service:** [`services/order-lookup-voice-agent/`](services/order-lookup-voice-agent/)

| Endpoint | Purpose |
|----------|---------|
| `POST /conversationBrain/inbound` | Twilio voice webhook (TwiML → ConversationRelay) |
| `WS /conversationBrain/ws` | ConversationRelay WebSocket |
| `GET /health` | Health check |

PM2 starts **only** `order-lookup-voice-agent` (see [`ecosystem.config.cjs`](ecosystem.config.cjs)).

## Prerequisites

- Node.js **20+**
- Postgres (session persistence / HA; optional — agent falls back to in-memory L1)
- Twilio account with a phone number
- OpenAI API key
- Shopify Admin API token
- Resend API key (checkout / support email)
- ElevenLabs voice id (ConversationRelay TTS via Twilio)

## Environment variables

```bash
cd services/order-lookup-voice-agent
cp .env.example .env   # if present; otherwise create .env
```

Key variables:

| Variable | Purpose |
|----------|---------|
| `PUBLIC_BASE_URL` | Public HTTPS origin Twilio can reach |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio auth |
| `OPENAI_API_KEY` | LLM orchestration + tools |
| `SHOPIFY_SHOP_DOMAIN` / `SHOPIFY_ADMIN_ACCESS_TOKEN` | Catalog + orders |
| `DATABASE_URL` | Postgres for `call_sessions` L2 persistence |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | Checkout + escalation email |
| `VOICE_ID` | ElevenLabs voice for ConversationRelay |
| `VOICE_RUNTIME` | Default `twilio_conversation_relay` |

## Local development

```bash
cd services/order-lookup-voice-agent
npm ci
npm run build
npm run dev
```

Point Twilio (or ngrok) at:

```
Voice webhook:  https://<public-host>/conversationBrain/inbound
WebSocket:      wss://<public-host>/conversationBrain/ws
```

Set `PUBLIC_BASE_URL=https://<public-host>` in `.env`.

### Postgres (optional locally)

```bash
# Example local URL
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/voice_agent_db

npx tsx scripts/runMigrations.ts
```

Without `DATABASE_URL`, sessions stay in-process only.

## Linux VPS (production)

```bash
cd /var/www/voice-agent
git pull origin production-ready

cd services/order-lookup-voice-agent
npm ci
npm run build
npx tsx scripts/runMigrations.ts   # requires DATABASE_URL in .env

cd /var/www/voice-agent
pm2 restart order-lookup-voice-agent --update-env
# or first boot:
# pm2 start ecosystem.config.cjs && pm2 save

curl -sS http://127.0.0.1:8001/health
```

Nginx should proxy `/conversationBrain/inbound`, `/conversationBrain/ws`, and `/health` to port **8001**. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Tests

```bash
cd services/order-lookup-voice-agent
npm test
```

All Shopify / OpenAI / Resend calls are mocked in unit tests.

## Health check

```bash
curl -sS http://127.0.0.1:8001/health
```

Expect `ok: true` for `order-lookup-voice-agent`. With Postgres configured, session persistence should report enabled.

## License

Private client delivery.
