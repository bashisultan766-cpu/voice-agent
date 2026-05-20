# External dependencies

All items below are **outside this repository**. Configure accounts, credentials, and DNS/TLS in your client’s environment. This document is the handoff checklist for integrations.

## Required for production voice + commerce

| Service | Purpose | What you need |
|--------|---------|----------------|
| **PostgreSQL** | App data (Prisma) | `DATABASE_URL`, backups, migrations on deploy |
| **Twilio** | Inbound voice, webhooks | Phone number(s), `TWILIO_AUTH_TOKEN`, Voice webhook → `POST /api/twilio/voice/inbound` (or legacy path per controller), `PUBLIC_WEBHOOK_BASE_URL` matching the URL Twilio calls |
| **Shopify** | Products, checkout, draft orders | Custom app or private app with Admin API + (for cart permalinks) Storefront-related access as implemented; per-agent **store URL** + **encrypted admin token** in the dashboard |
| **OpenAI** | Realtime / tools / LLM | `OPENAI_API_KEY`; agent-level override supported where implemented |

## Required for payment emails

| Service | Purpose | What you need |
|--------|---------|----------------|
| **Resend** (or future provider) | Transactional email for checkout links | `RESEND_API_KEY`, verified-domain **`RESEND_FROM_EMAIL`** (production validation requires `RESEND_FROM_EMAIL` when `RESEND_API_KEY` is set) |

## Optional

| Service | Purpose | Notes |
|--------|---------|--------|
| **ElevenLabs** | TTS / voice | `ELEVENLABS_*`; omit if using OpenAI-native voice only |
| **Redis** | Queues / cache (if enabled in your deployment) | `REDIS_URL`; confirm Bull/worker processes in your hosting setup |
| **Reverse proxy** | TLS, routing | Set `TRUST_PROXY=true` when the API sits behind nginx/Caddy so Twilio signatures use correct URL |

## URLs that must be reachable from the internet

- **Twilio voice webhooks** — HTTPS, stable host; must match `PUBLIC_WEBHOOK_BASE_URL` + path the console is configured with.
- **Shopify Admin webhooks** (if registered) — `POST /api/integrations/shopify/webhooks` with raw body for HMAC (already configured in the API bootstrap).

## Not bundled

- SSL certificates (use Let’s Encrypt / host-managed TLS).
- Log aggregation, APM, or error tracking (recommended add-ons: e.g. OpenTelemetry, Sentry).
- Multi-region failover or read replicas (architecture is single-primary Postgres as shipped).
