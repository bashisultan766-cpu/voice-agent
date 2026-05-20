# Step 1 (P0 — Foundation) — Required Env/Config Checklist

**Purpose:** Coding سے پہلے یہ variables mentally freeze کریں۔ کوئی بھی نیا env variable اس checklist کے بغیر add نہ کریں۔

**Design note:** ہر Shopify store کا token global env میں hardcode نہیں ہونا چاہیے۔ Tenant/store-level tokens DB میں encrypted رکھے جائیں؛ env میں صرف encryption key اور platform-level config ہو۔

---

## Checklist (Step 1 Required)

Coding start کرنے سے پہلے ہر item verify کریں:

- [ ] **Core** — `NODE_ENV`, `APP_URL`, `API_URL` set اور documented
- [ ] **Database** — `DATABASE_URL` valid اور Prisma/migrations کے لیے ready
- [ ] **Redis** — `REDIS_URL` set (cache/session/queue)
- [ ] **Auth** — Clerk keys set; sign-in/sign-up flows test
- [ ] **OpenAI** — API key + model name; no store-specific key in env
- [ ] **Twilio** — Account + auth + phone + optional API key/secret + TwiML app SID
- [ ] **Shopify** — صرف **app-level** keys (API key, secret, webhook secret); store tokens **DB میں**
- [ ] **Encryption** — `ENCRYPTION_KEY` for DB-stored secrets (store tokens, etc.)
- [ ] **Storage** — S3 (or equivalent) اگر Step 1 میں file upload/recordings ہوں؛ ورنہ Later
- [ ] **Monitoring** — Sentry + PostHog اگر Step 1 میں onboard ہوں؛ ورنہ Later

---

## 1. Core

| Variable | Required Step 1 | Example | Notes |
|----------|-----------------|---------|--------|
| `NODE_ENV` | ✅ | `development` / `production` / `test` | Always set |
| `APP_URL` | ✅ | `https://app.example.com` | Frontend base URL (Clerk redirects, links) |
| `API_URL` | ✅ | `https://api.example.com` or same origin | Backend base URL for API calls |

---

## 2. Database

| Variable | Required Step 1 | Example | Notes |
|----------|-----------------|---------|--------|
| `DATABASE_URL` | ✅ | `postgresql://user:pass@host:5432/db?schema=public` | Prisma datasource; never log |

---

## 3. Redis

| Variable | Required Step 1 | Example | Notes |
|----------|-----------------|---------|--------|
| `REDIS_URL` | ✅ | `redis://localhost:6379` or `rediss://...` | Cache (agent config), session, queue |

---

## 4. Auth (Clerk)

| Variable | Required Step 1 | Example | Notes |
|----------|-----------------|---------|--------|
| `CLERK_SECRET_KEY` | ✅ | `sk_test_...` | Server-only; verify JWT, get tenant/user |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | ✅ | `pk_test_...` | Client-side; sign-in UI |

---

## 5. OpenAI

| Variable | Required Step 1 | Example | Notes |
|----------|-----------------|---------|--------|
| `OPENAI_API_KEY` | ✅ | `sk-...` | Server-only; LLM + optional STT/TTS |
| `OPENAI_REALTIME_MODEL` | Optional Step 1 | `gpt-4o-realtime-preview` or chat model | Use when voice pipeline uses Realtime API; else use standard chat model name in code |

**Note:** Per-tenant OpenAI key بعد میں DB/vault میں رکھا جا سکتا ہے؛ Step 1 میں ایک platform key کافی ہے۔

---

## 6. Twilio

| Variable | Required Step 1 | Example | Notes |
|----------|-----------------|---------|--------|
| `TWILIO_ACCOUNT_SID` | ✅ | `AC...` | Platform/tenant account |
| `TWILIO_AUTH_TOKEN` | ✅ | — | Server-only; never log |
| `TWILIO_PHONE_NUMBER` | ✅ (dev/test) | `+1234567890` | Default number for testing; production میں numbers DB/tenant-assigned |
| `TWILIO_API_KEY` | Optional | — | If using API key for server-side calls |
| `TWILIO_API_SECRET` | Optional | — | Pair with API key |
| `TWILIO_TWIML_APP_SID` | ✅ (when voice live) | — | TwiML App for voice webhook URL |

**Note:** Multi-tenant میں Twilio credentials بعد میں `TenantIntegration` (DB) میں رکھے جا سکتے ہیں؛ Step 1 میں single-tenant کے لیے env OK۔

---

## 7. Shopify (App-Level Only)

| Variable | Required Step 1 | Example | Notes |
|----------|-----------------|---------|--------|
| `SHOPIFY_API_KEY` | ✅ | App’s API key (Client ID) | Public; app identity |
| `SHOPIFY_API_SECRET` | ✅ | App’s secret | Server-only; verify webhooks, OAuth |
| `SHOPIFY_WEBHOOK_SECRET` | ✅ | Shared secret for webhook verification | Or derive from app secret |

**Critical:** ہر store کا access token env میں **نہیں**۔ Store install کے بعد token **DB** میں (`StoreCredential` یا equivalent) **encrypted** save کریں؛ `ENCRYPTION_KEY` سے encrypt/decrypt۔

---

## 8. Encryption

| Variable | Required Step 1 | Example | Notes |
|----------|-----------------|---------|--------|
| `ENCRYPTION_KEY` | ✅ | 32-byte hex or base64 key | DB-stored secrets (e.g. Shopify store token) encrypt/decrypt; rotate with care |

---

## 9. Storage (S3)

| Variable | Required Step 1 | Example | Notes |
|----------|-----------------|---------|--------|
| `S3_BUCKET` | Later | — | When uploads/recordings needed |
| `S3_REGION` | Later | — | |
| `S3_ACCESS_KEY_ID` | Later | — | |
| `S3_SECRET_ACCESS_KEY` | Later | — | |

Step 1 میں اگر کوئی file/recording storage نہیں، یہ optional رکھیں۔

---

## 10. Monitoring

| Variable | Required Step 1 | Example | Notes |
|----------|-----------------|---------|--------|
| `SENTRY_DSN` | Optional | `https://...@sentry.io/...` | Errors; empty = disabled |
| `POSTHOG_API_KEY` | Optional | `phc_...` | Analytics; empty = disabled |

Step 1 میں optional؛ production میں recommend کریں۔

---

## Summary: Step 1 Minimum Set

یہ variables **must** set ہوں قبل از coding Step 1:

```
# Core
NODE_ENV=
APP_URL=
API_URL=

# Database
DATABASE_URL=

# Redis
REDIS_URL=

# Auth (Clerk)
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=

# OpenAI
OPENAI_API_KEY=
OPENAI_REALTIME_MODEL=          # optional if not using Realtime API yet

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=            # dev/test default
TWILIO_API_KEY=                 # optional
TWILIO_API_SECRET=              # optional
TWILIO_TWIML_APP_SID=           # when voice webhook is implemented

# Shopify (app-level only; store tokens in DB)
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_WEBHOOK_SECRET=

# Encryption (for DB-stored store tokens)
ENCRYPTION_KEY=
```

**Optional for Step 1:** `S3_*`, `SENTRY_DSN`, `POSTHOG_API_KEY`, `OPENAI_REALTIME_MODEL`, `TWILIO_API_KEY`/`TWILIO_API_SECRET`.

---

## Rules to Freeze

1. **No store/tenant secrets in env** — Shopify store tokens, tenant-specific Twilio/OpenAI keys → DB (encrypted) or vault later.
2. **Env = platform and defaults only** — App URL, DB, Redis, auth, one OpenAI key, one Twilio account for dev, encryption key.
3. **`.env` never committed** — Use `.env.example` (no real values); document every key here.
4. **Naming** — `NEXT_PUBLIC_*` only for client-safe values; باقی server-only.

---

---

## Copy as `.env.example`

پروجیکٹ root پر `.env.example` بنا کر نیچے والا block paste کریں (values خالی رکھیں یا placeholder):

```
# Core
NODE_ENV=development
APP_URL=http://localhost:3000
API_URL=http://localhost:3000

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/voice_agent_db?schema=public

# Redis
REDIS_URL=redis://localhost:6379

# Auth (Clerk)
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=

# OpenAI
OPENAI_API_KEY=
OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_API_KEY=
TWILIO_API_SECRET=
TWILIO_TWIML_APP_SID=

# Shopify (app-level; store tokens in DB)
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_WEBHOOK_SECRET=

# Encryption (DB-stored secrets)
ENCRYPTION_KEY=

# Optional: S3, Sentry, PostHog
# S3_BUCKET= S3_REGION= S3_ACCESS_KEY_ID= S3_SECRET_ACCESS_KEY=
# SENTRY_DSN= POSTHOG_API_KEY=
```

**یاد رکھیں:** `.env` کو git میں commit نہ کریں؛ `.gitignore` میں `.env` شامل کریں۔

---

*Document version: 1.0 — Step 1 (P0) env/config freeze.*
