# Emergency Production Latency Fix Report

**Date:** 2026-06-26  
**Service:** `twilio-voice-agent`  
**Status:** Implemented and validated (667 tests passing)

---

## Root Cause

Two independent problems combined to make live calls unusably slow:

### 1. Postgres connection refused → log spam + background write pressure

When `DATABASE_URL` was set but Postgres was unreachable (`ConnectionRefusedError`), every turn triggered background persistence tasks (`persist_turn_if_configured`, `record_workflow_event`, metrics writes). Each attempt logged `postgres_write_failed` and retried pool creation. This did not block the caller directly, but added async overhead and noisy logs on every turn during live calls.

### 2. Smalltalk routed to supervisor LLM (15.8s `supervisor_ms`)

Utterances like **"Hello. How are you?"** were classified as `smalltalk` with confidence **0.90**. The supervisor only skipped the LLM at confidence **≥ 0.92**, so `gpt-4o-mini` was invoked for trivial greetings. That produced `supervisor_ms=15896` and caused the caller to interrupt before the response arrived.

---

## Changes Made

### Phase 1 — Postgres circuit breaker (`app/db/connection.py`)

| Behavior | Detail |
|----------|--------|
| Missing `DATABASE_URL` | One startup warning; persistence disabled for process |
| Unreachable at startup (`STRICT_POSTGRES=false`) | One warning; persistence disabled |
| Runtime failures | Circuit opens after 2 failures; 5-minute cooldown |
| During cooldown | Writes return immediately — no pool attempt, no log spam |
| `STRICT_POSTGRES=true` | Startup fails if DB missing/unreachable; writes still raise |

**Gated callers:** `postgres_store.py`, `event_store.py`, `metrics_collector.py` now use `postgres_writes_enabled()` / `postgres_reads_enabled()` instead of only `db_configured()`.

### Phase 2 — Deterministic smalltalk (`app/orchestrator/intent_router.py`)

- `is_smalltalk()` handles compound greetings ("Hello. How are you?")
- Smalltalk confidence raised to **0.96**
- `resolve_smalltalk_response()` returns instant scripted replies
- `is_fast_path_supervisor_result()` — supervisor LLM never called for smalltalk

**Example responses:**

| User | Assistant |
|------|-----------|
| Hello | Hi, this is SureShot Books. How can I help you today? |
| How are you? | I'm doing well, thank you. What book or order can I help you with? |
| Hello, how are you? | I'm doing well, thank you. What can I help you find today? |

### Phase 3 — Incomplete utterances (`app/orchestrator/intent_router.py`)

Detects fragments: "Can I have", "I want", "Can you find", "I'm looking for".

- No LLM
- Clarification: *"Sure — what title or ISBN are you looking for?"*

### Phase 4 — Fast path for common intents

`FAST_PATH_INTENTS` + `is_fast_path_supervisor_result()` bypass supervisor LLM for:

- Greetings / smalltalk / yes-no
- ISBN (≥0.96), order number (≥0.94), email capture (≥0.95)
- Payment FSM (handled before supervisor in `runtime.py`)
- Facility keywords (≥0.94), refund with verification (≥0.94)
- Product search with obvious title pattern (≥0.94)
- Security clarifications (order/refund unverified)

`runtime.py` runs heuristics first and skips `run_supervisor()` entirely on fast-path hits.

### Phase 5 — Composer fast path (`app/orchestrator/response_composer.py`)

Smalltalk uses `resolve_smalltalk_response()` — no composer LLM.

---

## Files Changed

| File | Change |
|------|--------|
| `app/db/connection.py` | Circuit breaker, graceful degradation, startup warnings |
| `app/memory/postgres_store.py` | Gate on `postgres_writes_enabled()` |
| `app/workflow/event_store.py` | Gate on `postgres_writes_enabled()` |
| `app/analytics/metrics_collector.py` | Gate on `postgres_reads_enabled()` |
| `app/orchestrator/intent_router.py` | Smalltalk, incomplete, yes/no, fast-path logic |
| `app/orchestrator/supervisor_agent.py` | Skip LLM for fast-path intents |
| `app/orchestrator/runtime.py` | Heuristic-first supervisor shortcut |
| `app/orchestrator/response_composer.py` | Deterministic smalltalk responses |
| `app/tests/test_emergency_production_latency_fix.py` | 27 new tests |

---

## Tests Added

`app/tests/test_emergency_production_latency_fix.py` — 27 tests covering:

- Postgres refused → circuit opens, writes skipped after 2 attempts
- Only one `postgres_circuit_open` log during cooldown (no `postgres_write_failed` spam)
- Live turn not blocked when Postgres unavailable (<200ms)
- `STRICT_POSTGRES=true` startup and write failure behavior
- Hello / How are you / Hello how are you — no OpenAI supervisor or composer call
- Smalltalk runtime <200ms mocked
- Incomplete utterance detection and no-LLM clarification
- ISBN fast path skips supervisor LLM
- Background postgres tasks not scheduled when circuit open

**Full suite:** `667 passed`

---

## Before / After Expected Latency

| Scenario | Before | After |
|----------|--------|-------|
| "Hello. How are you?" | ~15,800ms (`supervisor_ms` + LLM) | **<200ms** (heuristic only) |
| Postgres down, normal turn | Repeated async write attempts + log spam | **0ms blocking**; writes skipped in cooldown |
| "Can I have" | Processed as unknown → possible LLM | **<200ms** clarification, no LLM |
| ISBN / order # / facility | Often fast already | Guaranteed fast path at ≥0.92–0.96 confidence |

---

## Production Environment Recommendation

```env
# Required for live calls
REDIS_URL=redis://...
OPENAI_API_KEY=sk-...

# Postgres — optional for live call handling
DATABASE_URL=postgresql://user:pass@host:5432/voice_agent

# Graceful degradation when DB is down (recommended for voice uptime)
STRICT_POSTGRES=false

# Only enable when Postgres is a hard dependency for deployment
# STRICT_POSTGRES=true
```

### Operational notes

1. **Voice calls must not depend on Postgres.** Redis + orchestrator are the live path. Postgres is analytics/audit only.
2. If Postgres is intentionally required (e.g. compliance), set `STRICT_POSTGRES=true` and ensure `DATABASE_URL` points to a healthy instance before deploy.
3. After a Postgres outage with `STRICT_POSTGRES=false`, the process disables persistence at startup OR opens a 5-minute circuit. Recovery after cooldown is automatic without restart.
4. Monitor for a single `postgres_circuit_open` or `postgres_persistence_disabled` warning — not repeated `postgres_write_failed` lines.

---

## Validation Commands

```bash
cd services/twilio-voice-agent
python -m compileall app -q
python -m pytest -q --tb=short
```

Both completed successfully at time of this report.
