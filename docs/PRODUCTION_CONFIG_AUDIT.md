# Production Configuration Audit

**Service:** `services/twilio-voice-agent`  
**Date:** 2026-06-26  
**Scope:** Environment variables and runtime flags for production deployment

---

## Summary

| Category | Required in prod | Optional | Unsafe default | Missing validation |
|----------|------------------|----------|----------------|-------------------|
| APP_ENV | ✅ | — | `development` | Partial — `validate_production()` |
| REDIS_URL | ✅ | — | localhost OK in dev | ✅ startup + gate |
| DATABASE_URL | — | ✅ | empty | ✅ if STRICT_POSTGRES |
| Shopify | ✅ | — | empty | Gate only |
| OpenAI | ✅ | — | empty | `validate_production()` |
| Resend | ✅ | — | example email | Gate only |
| Twilio | ✅ | — | empty | `validate_production()` |
| SUPPORT_EMAIL | ✅* | — | empty | `validate_production()` if escalation on |
| OTEL | — | ✅ | disabled | Gate warns if enabled without endpoint |
| Admin endpoints | — | ✅ | disabled | Gate + ALLOW flag |
| Orchestrator | Recommended | — | enabled | Gate informational |
| Legacy fallback | Policy | — | enabled | Gate checks explicit env |

\* Required when `SUPPORT_ESCALATION_ENABLED=true`

---

## APP_ENV

| Value | Use |
|-------|-----|
| `production` | Live traffic — Redis required, no in-memory session fallback |
| `test` | Pytest — memory fallbacks allowed |
| `development` | Local dev — **unsafe for live calls** |

**Required in production:** `APP_ENV=production`

**Unsafe default:** `development` (disables production hardening)

**Validation:** `Settings.is_production`, `allow_memory_store_fallback`, `validate_production()`

**Gap:** `DEBUG=true` skips `validate_production()` entirely — never set `DEBUG=true` in prod.

---

## REDIS_URL

**Required in production:** Yes — session state, caller profiles, payment idempotency, rate limits, escalation idempotency.

**Optional:** No in production.

**Unsafe default:** `redis://127.0.0.1:6379` (fine if Redis co-located).

**Validation:** `verify_redis_at_startup()`, pre-deploy gate ping.

---

## DATABASE_URL

**Required in production:** No (Redis remains live store).

**Optional:** Yes — workflow replay, analytics, evaluations (Steps 11–12).

**Unsafe default:** Empty (analytics disabled — acceptable).

**Validation:** `verify_postgres_at_startup()` when `STRICT_POSTGRES=true`.

---

## Shopify credentials

| Var | Required |
|-----|----------|
| `SHOPIFY_SHOP_DOMAIN` | Yes |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Yes |
| `SHOPIFY_API_VERSION` | Default `2026-01` |
| `SHOPIFY_WEBHOOK_SECRET` | If webhooks enabled |

**Unsafe default:** Empty tokens — catalog/order tools fail.

**Validation:** `shopify_configured` property; pre-deploy gate.

---

## OpenAI models

| Var | Production guidance |
|-----|---------------------|
| `OPENAI_API_KEY` | **Required** |
| `OPENAI_MODEL` | `gpt-4o` (final speech) |
| `OPENAI_FAST_MODEL` | `gpt-4o-mini` (supervisor/composer) |
| `OPENAI_STRONG_MODEL` | Complex multi-tool turns |

**Unsafe default:** Empty API key.

**Validation:** `validate_production()`, `/health` `openai_configured`.

---

## Resend

| Var | Required |
|-----|----------|
| `RESEND_API_KEY` | Yes (payment links + escalations) |
| `RESEND_FROM_EMAIL` | Yes |
| `RESEND_FROM_NAME` | Recommended |

**Unsafe default:** `noreply@example.com` — emails will fail.

**Validation:** Pre-deploy gate; payment path blocks if not configured.

---

## Twilio

| Var | Required |
|-----|----------|
| `TWILIO_ACCOUNT_SID` | Yes |
| `TWILIO_AUTH_TOKEN` | Yes |
| `TWILIO_PHONE_NUMBER` | Recommended |
| `VALIDATE_TWILIO_SIGNATURES` | `true` in production |
| `PUBLIC_BASE_URL` | `https://` required |

**WS auth:** `WS_TOKEN_VALIDATION_ENABLED=true`, `WS_TOKEN_SECRET` or `INTERNAL_ADMIN_KEY`.

**Unsafe default:** Signature validation off in dev only.

---

## SUPPORT_EMAIL

**Required in production when:** `SUPPORT_ESCALATION_ENABLED=true` (default).

**Validation:** `validate_production()`, pre-deploy gate.

---

## OTEL

| Var | Default |
|-----|---------|
| `OTEL_ENABLED` | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty |

**Optional** — enable in staging first.

**Gap:** No auto-fail if `OTEL_ENABLED=true` without endpoint (gate warns).

---

## Admin endpoints

| Var | Production default |
|-----|-------------------|
| `ENABLE_ADMIN_DEBUG_ENDPOINTS` | `false` |
| `INTERNAL_ADMIN_KEY` | Required if admin/sync enabled |
| `ALLOW_ADMIN_DEBUG_IN_PRODUCTION` | Must be `true` to allow debug in prod |

Endpoints: `/admin/sync`, `/admin/sessions/*`, `/admin/analytics/*`

**Unsafe:** Debug endpoints on public internet without IP allowlist.

---

## Orchestrator flags

| Var | Default | Production |
|-----|---------|------------|
| `VOICE_ORCHESTRATOR_ENABLED` | `true` | Keep `true` |
| `VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED` | `true` | Set explicitly; monitor `fallback_runtime_calls` |
| `VOICE_AGENT_RUNTIME_MODE` | `llm_tool_runtime` | Label only when orchestrator on |

---

## Legacy fallback flags

`VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED=true` allows one-turn fallback to `llm_tool_runtime` on orchestrator crash.

**Policy:** Keep enabled for one release; set env var explicitly in deploy manifest; watch analytics `fallback_runtime_calls`.

**Quarantined (must be false):** `ENABLE_ELEVENLABS`, `ENABLE_DEEPGRAM`, `VOICE_LLM_BRAIN_ENABLED`

---

## API docs

| Var | Production |
|-----|------------|
| `ENABLE_API_DOCS` | `false` or ignored when `APP_ENV=production` and `DEBUG=false` |
| `DEBUG` | **Must be `false`** |

`api_docs_enabled` is false in production unless `DEBUG=true` (unsafe).

---

## Pre-deploy gate

Run before every production deploy:

```bash
cd services/twilio-voice-agent
APP_ENV=production python scripts/pre_deploy_health_gate.py
```

---

## Recommended production `.env` checklist

```env
APP_ENV=production
DEBUG=false
PUBLIC_BASE_URL=https://agent.example.com
REDIS_URL=redis://127.0.0.1:6379
DATABASE_URL=postgresql://...        # optional
STRICT_POSTGRES=false
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
VALIDATE_TWILIO_SIGNATURES=true
WS_TOKEN_VALIDATION_ENABLED=true
OPENAI_API_KEY=...
SHOPIFY_SHOP_DOMAIN=...
SHOPIFY_ADMIN_ACCESS_TOKEN=...
RESEND_API_KEY=...
RESEND_FROM_EMAIL=...
SUPPORT_EMAIL=...
VOICE_ORCHESTRATOR_ENABLED=true
VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED=true
ENABLE_ADMIN_DEBUG_ENDPOINTS=false
ENABLE_API_DOCS=false
ENABLE_LLM_EVAL=false
OTEL_ENABLED=false
```
