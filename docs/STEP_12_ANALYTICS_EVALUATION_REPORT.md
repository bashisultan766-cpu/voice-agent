# STEP 12 — Analytics, Evaluation & Monitoring Report

**Date:** 2026-06-26  
**Scope:** Call metrics, AI evaluation, admin analytics APIs, daily reporting

---

## Analytics models

Migration: `app/db/migrations/002_analytics_schema.sql`

### `call_metrics`

| Field | Description |
|-------|-------------|
| `session_id` | FK to `call_sessions` (unique per call) |
| `call_sid` | Twilio call SID |
| `duration_seconds` | Call length from session start/end |
| `total_turns` | `user_turn_received` workflow events |
| `successful_tools` / `failed_tools` | From `tool_events` |
| `avg_turn_latency_ms` / `max_turn_latency_ms` | Tool + turn-gap latencies |
| `payment_link_sent` | Workflow `payment_link_created` |
| `escalation_created` | Workflow `escalation_created` |
| `order_lookup_count` | `lookup_order_status` tools |
| `refund_lookup_count` | `lookup_refund_status` tools |
| `product_search_count` | Search/catalog tools |
| `facility_query_count` | Facility policy tools |

Python models: `app/analytics/models.py` — `CallMetrics`, `AgentEvaluation`

### `agent_evaluations`

| Field | Range |
|-------|-------|
| `intent_success_score` | 0–100 |
| `tool_selection_score` | 0–100 |
| `response_quality_score` | 0–100 |
| `safety_score` | 0–100 |
| `latency_score` | 0–100 |
| `overall_score` | Weighted composite |
| `issues_json` | Deterministic issue codes |

---

## Metrics collector

`app/analytics/metrics_collector.py`

Collects from `workflow_events` + `tool_events` + `call_sessions`:

- Call count, average latency, tool success/failure
- Payment conversion (`payment_link_sent` / calls)
- Escalation count
- Top search terms (masked) from product search tool inputs
- Top facility queries (masked)
- Fallback runtime usage (`runtime_mode != orchestrator`)
- Not-found escalation count

Post-call hook: `app/analytics/post_call.py` → `finalize_call_analytics()` scheduled on WebSocket disconnect (never blocks live call).

---

## Evaluator behavior

`app/evaluation/call_evaluator.py`

| Mode | When |
|------|------|
| **Deterministic** (default) | Always after call end |
| **LLM refine** | Only if `ENABLE_LLM_EVAL=true` + `OPENAI_API_KEY` |

Scoring rules:

- **Intent success** — tool success ratio
- **Tool selection** — penalties per failed tool
- **Response quality** — escalations, empty turns, multiple failures
- **Safety** — payment tool failures, safety/blocked error codes
- **Latency** — thresholds at 2s / 3s / 5s avg and max

PII/secrets: `build_evaluator_context()` uses `mask_payload()`; LLM receives masked JSON only. Evaluation runs post-call via `asyncio.create_task`, not on live turn path.

---

## Admin endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /admin/analytics/summary` | Platform aggregate (7-day default) |
| `GET /admin/analytics/calls` | Recent per-call metrics |
| `GET /admin/analytics/failures` | Tool failure breakdown |
| `GET /admin/analytics/evaluations` | Recent evaluation scores |

**Auth:** `X-Admin-Key` + `ENABLE_ADMIN_DEBUG_ENDPOINTS=true` + rate limiting  
**Output:** Masked aggregates only — no raw email/phone/payment URLs

---

## Report script

`scripts/generate_daily_voice_agent_report.py`

```bash
python scripts/generate_daily_voice_agent_report.py
python scripts/generate_daily_voice_agent_report.py --date 2026-06-26
```

Output: `docs/reports/YYYY-MM-DD_voice_agent_report.md`

Includes: calls, payments, searches, escalations, order/refund/facility counts, latency, failures, top terms, avg evaluation score, recommended fixes.

---

## Files changed

| File | Change |
|------|--------|
| `app/db/migrations/002_analytics_schema.sql` | **New** |
| `app/db/connection.py` | Apply all `migrations/*.sql` |
| `app/analytics/models.py` | **New** |
| `app/analytics/metrics_collector.py` | **New** |
| `app/analytics/post_call.py` | **New** |
| `app/evaluation/call_evaluator.py` | **New** |
| `app/api/admin_analytics.py` | **New** |
| `app/config.py` | `ENABLE_LLM_EVAL` |
| `app/main.py` | Admin analytics router |
| `app/ws/conversation_relay.py` | Post-call analytics task |
| `scripts/generate_daily_voice_agent_report.py` | **New** |
| `app/tests/test_step12_analytics_evaluation.py` | **New** — 12 tests |
| `.env.example` | `ENABLE_LLM_EVAL` |

**Unchanged:** payment safety, order privacy, facility safety, not-found escalation, WS auth, rate limits, workflow replay.

---

## Tests added (12)

1. Metrics collector counts tool success/failures  
2. Metrics collector counts payment links  
3. Metrics collector counts escalations  
4. Metrics collector counts product searches  
5. Evaluator masks PII  
6. Evaluator produces deterministic score  
7. Low safety event lowers score  
8. High latency lowers score  
9. Admin analytics endpoint requires key  
10. Admin analytics endpoint disabled by default  
11. Daily report script creates markdown report  
12. No raw full email/phone/payment URL in analytics output  

---

## Test results

```text
python -m compileall app -q          # OK
python -m pytest -q --tb=short     # 631 passed (full suite)
```

---

## Env vars

```env
ENABLE_ADMIN_DEBUG_ENDPOINTS=false
ENABLE_LLM_EVAL=false
DATABASE_URL=postgresql://...
```

---

## Updated scores (estimate)

| Area | Step 11 | Step 12 |
|------|--------:|--------:|
| Observability & audit trail | 90 | **94** |
| Enterprise readiness | 85 | **88** |
| Analytics / SaaS measurability | 45 | **86** |
| Overall requirement-fit | 87 | **89** |

---

## Next recommended step

1. Enable `DATABASE_URL` in staging and validate post-call metrics after live calls  
2. Schedule `generate_daily_voice_agent_report.py` via cron (e.g. 06:00 UTC)  
3. Dashboard Grafana/Datadog from `call_metrics` + `agent_evaluations` tables  
4. Set evaluation score alerts when `overall_score < 70` or `safety_score < 80`
