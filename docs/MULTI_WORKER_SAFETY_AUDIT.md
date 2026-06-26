# Multi-Worker Safety Audit

**Service:** `services/twilio-voice-agent`  
**Date:** 2026-06-26  
**Verdict:** **Single worker per instance** with **sticky WebSocket sessions** at the load balancer.

---

## Executive recommendation

| Deployment mode | Safe? | Notes |
|-----------------|-------|-------|
| PM2 `instances: 1`, `workers: 1` | ✅ **Recommended** | Current `ecosystem.config.cjs` |
| PM2 cluster (multiple Node processes) | ⚠️ **Not safe** without sticky WS + shared Redis | See gaps below |
| Horizontal containers (K8s/ECS) | ⚠️ **Needs sticky sessions** | One active WS per call on one pod |
| Serverless / multi-worker uvicorn | ❌ **Not safe** | In-memory state + circuit breaker |

---

## Component audit

### Redis session state — ✅ Shared

`app/state/session_store.py` — Redis primary; in-memory fallback **disabled in production**.

Call resume, caller profiles, payment idempotency keys, escalation idempotency, rate limits (production) all use Redis.

**Scaling:** Safe across workers **if all workers share one Redis**.

---

### Payment idempotency — ✅ Redis-backed

`app/payment/payment_idempotency.py` — idempotency keys in Redis.

**Scaling:** Safe multi-worker with shared Redis.

---

### WebSocket session affinity — ❌ Needs sticky sessions

`SessionState` lives **in-process** during an active call (`conversation_relay.py`).

Twilio ConversationRelay maintains one long-lived WS to one backend instance.

**Scaling:** Load balancer must use **sticky sessions** (cookie/IP hash) for `/voice/twilio/ws`. Inbound webhook can hit any worker (stateless TwiML).

---

### In-memory caches — ⚠️ Per-process

| Cache | Location | Risk |
|-------|----------|------|
| Session store fallback | `session_store._MEMORY` | Disabled in prod |
| Rate limit buckets | `rate_limit._MEMORY_BUCKETS` | Dev/test only if Redis down |
| Product-not-found escalation | `_STORE` dict | Fallback if Redis unavailable |
| Shopify circuit breaker | `shopify_circuit_breaker._failures` | **Per-process** — inconsistent across workers |
| Turn assembler / interrupt context | In-process dicts | Per-call on one worker |

**Scaling:** Circuit breaker state is **not shared** — multiple workers each track failures independently. Acceptable at low scale; prefer single worker or external breaker at high scale.

---

### Shopify circuit breaker — ⚠️ Per-process

`app/reliability/shopify_circuit_breaker.py` — module-level `_failures` list.

**Recommendation:** Single worker OR move breaker state to Redis (future).

---

### Rate limiter — ✅ Redis in production

`app/security/rate_limit.py` — Redis when available; in-memory fallback in dev.

**Scaling:** Production should always have Redis reachable.

---

### Postgres writes — ✅ Safe

Async fire-and-forget writes from any worker; no in-process DB state.

**Scaling:** Safe multi-worker.

---

### Background analytics — ✅ Safe

`finalize_call_analytics()` scheduled post-call on the worker that held the WS.

**Scaling:** Each call evaluated once on disconnect worker.

---

### Policy / product caches — ⚠️ Redis TTL

Shopify product cache uses Redis (`SHOPIFY_CACHE_TTL_SECS`).

**Scaling:** Shared across workers.

---

## PM2 cluster safe?

**No** — not without:

1. `instances: 1` (current config) **or**
2. Sticky WS at Nginx + `ip_hash` upstream **and**
3. Shared Redis **and**
4. Acceptance of per-process circuit breaker

---

## Container scaling safe?

**Conditional yes:**

- Minimum: 1 replica per 50–100 concurrent calls (WS-bound)
- Nginx `ip_hash` or ALB sticky sessions on WebSocket path
- Single Redis cluster
- Do **not** increase uvicorn `--workers` above 1 for this app

---

## Needs Redis locks?

| Operation | Lock needed? |
|-----------|--------------|
| Payment send | Idempotency key — ✅已有 |
| Escalation email | Idempotency key — ✅ |
| Turn processing | Single WS — no cross-worker |
| Analytics persist | Upsert by session_id — safe |

**No additional Redis locks required** at current scale.

---

## Needs sticky sessions?

**Yes** — for `GET /voice/twilio/ws` only.

Nginx: see `infra/nginx/voice-agent.mailcallcommunication.com.conf` — single upstream today. For multi-backend, add `ip_hash` or separate WS upstream pool.

---

## Action items

1. Keep `ecosystem.config.cjs` at `instances: 1`, `--workers 1`
2. Before horizontal scale: add Nginx sticky WS upstream
3. Monitor `fallback_runtime_calls` and circuit breaker logs per instance
4. Future: Redis-backed circuit breaker if running 2+ workers
