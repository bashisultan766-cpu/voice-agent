# STEP 11 — Postgres Workflow Replay Report

**Date:** 2026-06-26  
**Scope:** Durable Postgres persistence, workflow event store, session replay, admin debug endpoints

---

## Schema added

Migration: `app/db/migrations/001_workflow_schema.sql` (applied automatically on startup when `DATABASE_URL` is set)

| Table | Purpose |
|-------|---------|
| `call_sessions` | Call metadata — `id`, `call_sid`, `phone_masked`, `started_at`, `ended_at`, `status`, `summary`, `runtime_mode` |
| `conversation_turns` | Masked user/assistant turns per session |
| `tool_events` | Tool name, status, masked input/output, latency |
| `payment_links` | Draft order id, masked URL and recipient |
| `escalations` | Escalation type and masked payload |
| `workflow_events` | Orchestration timeline (12 event types) |
| `customer_profiles` | `phone_hash`, masked email, last summary |

All PII fields are masked before insert. API keys, card data, and raw secrets are never stored.

---

## Files changed

| File | Change |
|------|--------|
| `app/db/migrations/001_workflow_schema.sql` | **New** — full schema |
| `app/db/connection.py` | **New** — asyncpg pool, schema bootstrap, `STRICT_POSTGRES` handling |
| `app/db/pii_masking.py` | **New** — email/phone/URL/payload masking |
| `app/memory/postgres_store.py` | **Upgraded** — real async writes (turns, sessions, tools, payments, escalations, profiles) |
| `app/workflow/event_store.py` | **New** — timeline, turn events, replay |
| `app/workflow/hooks.py` | **New** — fire-and-forget event helpers |
| `app/api/admin_debug.py` | **New** — timeline + replay endpoints |
| `app/config.py` | `STRICT_POSTGRES`, `ENABLE_ADMIN_DEBUG_ENDPOINTS` |
| `app/main.py` | Postgres startup verify, admin debug router |
| `app/memory/memory_manager.py` | `turn_id` on `record_turn` |
| `app/orchestrator/runtime.py` | Workflow events: user turn, supervisor, planner, composer, response |
| `app/orchestrator/tool_router.py` | Tool started/succeeded/failed + enriched tool_events |
| `app/ws/conversation_relay.py` | `call_started` / `call_ended` |
| `app/payment/payment_link_service.py` | `payment_link_created` |
| `app/tools/shopify_tools.py` | Human escalation persist |
| `app/escalation/product_not_found_escalation.py` | Not-found escalation persist |
| `requirements.txt` | `asyncpg>=0.30.0` |
| `.env.example` | `STRICT_POSTGRES`, `ENABLE_ADMIN_DEBUG_ENDPOINTS` |
| `app/tests/test_step11_postgres_workflow.py` | **New** — 15 tests |

**Unchanged (by design):** payment safety, order privacy, voice latency paths, facility safety, not-found escalation logic, WS auth, rate limits.

---

## Workflow events captured

| Event | Integration point |
|-------|-------------------|
| `call_started` | WebSocket `setup` |
| `call_ended` | WebSocket `finally` |
| `user_turn_received` | `OrchestratorRuntime.handle_turn` |
| `supervisor_result` | After `run_supervisor` |
| `planner_result` | After `run_planner` |
| `tool_started` | `tool_router.execute_step` |
| `tool_succeeded` / `tool_failed` | `tool_router.execute_step` |
| `composer_result` | After `compose_response` |
| `response_sent` | Before WS stream |
| `escalation_created` | `escalate_to_human`, `create_product_not_found_escalation` |
| `payment_link_created` | `send_confirmed_payment_link` success |

---

## Admin endpoints

| Endpoint | Auth | Default |
|----------|------|---------|
| `GET /admin/sessions/{session_id}/timeline` | `X-Admin-Key` + rate limit | **Disabled** (`ENABLE_ADMIN_DEBUG_ENDPOINTS=false`) |
| `GET /admin/sessions/{session_id}/replay` | `X-Admin-Key` + rate limit | **Disabled** |

Enable in dev/staging:

```env
ENABLE_ADMIN_DEBUG_ENDPOINTS=true
INTERNAL_ADMIN_KEY=your-key
DATABASE_URL=postgresql://...
```

---

## Tests added (15)

1. Postgres store masks email  
2. Postgres store masks phone  
3. Postgres store masks payment URL  
4. Workflow event recorded  
5. Session timeline returned in order  
6. Replay excludes secrets  
7. Admin endpoint requires key  
8. Admin endpoint disabled by default  
9. Tool events persist  
10. Escalation event persists  
11. Payment link event persists  
12. Postgres failure does not break dev call  
13. `STRICT_POSTGRES=true` startup requires `DATABASE_URL`  
14. Turn events filter by `turn_id`  
15. `STRICT_POSTGRES=true` write raises on failure  

---

## Test results

```text
python -m compileall app -q          # OK
python -m pytest -q --tb=short     # 619 passed (full suite)
```

---

## Env vars

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/voice_agent
STRICT_POSTGRES=false
ENABLE_ADMIN_DEBUG_ENDPOINTS=false
```

| Var | Behavior |
|-----|----------|
| `DATABASE_URL` | When set, enables async Postgres writes and schema bootstrap |
| `STRICT_POSTGRES=false` | Write failures logged/skipped — live calls continue (default) |
| `STRICT_POSTGRES=true` | Startup fails without DB; write failures raise |
| `ENABLE_ADMIN_DEBUG_ENDPOINTS=false` | Timeline/replay return 404 (default) |

---

## Updated scores (estimate)

| Area | Step 10 | Step 11 |
|------|--------:|--------:|
| Memory & persistence | 80 | **92** |
| n8n-style workflow / replay | 55 | **88** |
| Observability & audit trail | 82 | **90** |
| Overall requirement-fit | 85 | **87** |
| Overall enterprise score | 82 | **85** |

Redis remains the live runtime store; Postgres is the durable audit and replay layer.

---

## Next recommended step

1. Provision managed Postgres in staging; set `DATABASE_URL` and run a live call smoke test  
2. Enable `ENABLE_ADMIN_DEBUG_ENDPOINTS` in staging only; validate timeline/replay via `X-Admin-Key`  
3. Add retention policy (e.g. 90-day partition) before production volume  
4. Optional: wire `load_call_resume_if_configured` as secondary resume source after Redis miss
