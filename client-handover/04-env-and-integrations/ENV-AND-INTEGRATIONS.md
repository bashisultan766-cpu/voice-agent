# Environment variables and integrations

Reference for deployment and operations. Keep secrets in a secure store; never commit them.

---

## Required (production)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `NODE_ENV` | `production` or `staging` |
| `PORT` | API port (e.g. 3001) |
| `PUBLIC_WEBHOOK_BASE_URL` | Full base URL for webhooks (e.g. `https://api.example.com`) |
| `TWILIO_AUTH_TOKEN` | Twilio account auth token (for webhook validation) |
| `OPENAI_API_KEY` | OpenAI API key |

---

## Twilio

| Variable | Description |
|----------|-------------|
| `TWILIO_AUTH_TOKEN` | Required for signature validation |
| `PUBLIC_WEBHOOK_BASE_URL` | Must match URL Twilio calls (no trailing slash) |
| `VALIDATE_TWILIO_SIGNATURES` | Set to `true` (default); set `false` only for local dev |

**Webhook URLs to configure in Twilio:**

- Voice (inbound): `{PUBLIC_WEBHOOK_BASE_URL}/api/twilio/voice/inbound`
- Status callback: `{PUBLIC_WEBHOOK_BASE_URL}/api/twilio/voice/status`

---

## OpenAI

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Required for realtime and tools |
| `OPENAI_REALTIME_MODEL` | Optional; default model for voice |
| `OPENAI_VECTOR_STORE_ENABLED` | `true` to enable knowledge vector search |
| `OPENAI_MAX_TOOL_CALLS_PER_CALL` | Cap per call (e.g. 12) |

---

## Security and rate limits

| Variable | Description |
|----------|-------------|
| `ENCRYPTION_KEY` | 32-byte hex (64 chars) for at-rest encryption |
| `TRUST_PROXY` | `true` if behind reverse proxy |
| `API_RATE_LIMIT_WINDOW_MS` | Throttle window (e.g. 60000) |
| `API_RATE_LIMIT_MAX_REQUESTS` | Max requests per window per IP (e.g. 60) |

---

## Optional

| Variable | Description |
|----------|-------------|
| `SENTRY_DSN` | Error tracking |
| `POSTHOG_API_KEY` | Product analytics |
| `REDIS_URL` | If using Redis for jobs/cache |
| `S3_*` / storage | If using object storage for files |

---

## Third-party accounts

- **Twilio:** Account SID, Auth Token; phone numbers; voice webhook and status callback URLs.
- **Shopify:** App (custom or public) credentials; OAuth or token per store; required scopes (read products, orders, etc.).
- **OpenAI:** API key; usage and rate limits per tier.
- **Hosting:** API and web hosting accounts; env and secrets configured per environment.
- **Database:** Managed Postgres (e.g. Neon, Supabase, RDS); backup and access.
- **Monitoring:** Sentry, PostHog, or equivalent; access for technical owner.

Document who owns billing and who has admin access for each in the Access Inventory.
