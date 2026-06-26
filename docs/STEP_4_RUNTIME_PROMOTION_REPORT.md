# Step 4 — Runtime Promotion Report

**Date:** 2026-06-26  
**Status:** Orchestrator promoted to default live runtime  
**Test suite:** 489 passed (`python -m pytest -q`)

---

## Parity Results

15 orchestrator ↔ legacy parity scenarios were implemented in  
`services/twilio-voice-agent/app/tests/test_step4_orchestrator_parity.py`.

| # | Scenario | Orchestrator | Legacy | Safe Parity |
|---|----------|--------------|--------|-------------|
| 1 | ISBN search | ✅ search_products | ✅ search_products | ✅ |
| 2 | Title search | ✅ search_products | ✅ search_products | ✅ |
| 3 | Add to cart | ✅ cart intent | ✅ response safe | ✅ |
| 4 | Cart confirmation | ✅ FSM handled | ✅ FSM handled | ✅ |
| 5 | Email capture | ✅ no URLs | ✅ no URLs | ✅ |
| 6 | Email correction | ✅ no URLs | ✅ no URLs | ✅ |
| 7 | Create checkout | ✅ blocked (no email) | ✅ no payment tools | ✅ |
| 8 | Send payment link | ✅ blocked (no cart) | ✅ no payment tools | ✅ |
| 9 | Order lookup unverified | ✅ privacy clarification | ✅ privacy clarification | ✅ |
| 10 | Order lookup verified | ✅ lookup_order_status | ✅ safe response | ✅ |
| 11 | Refund lookup verified | ✅ lookup_refund_status | ✅ safe response | ✅ |
| 12 | Facility question | ✅ facility_policy_lookup | ✅ safe response | ✅ |
| 13 | Shipping question | ✅ shipping_policy_lookup | ✅ safe response | ✅ |
| 14 | Long conversation memory | ✅ MemoryManager ≥5 turns | ✅ memory intact | ✅ |
| 15 | Tool failure fallback | ✅ graceful fallback | ✅ graceful fallback | ✅ |

**Parity verdict:** All 15 scenarios pass. Step 2 payment, email, and privacy gates are preserved in both runtimes.

---

## Orchestrator Default

| Setting | Value | Notes |
|---------|-------|-------|
| `VOICE_ORCHESTRATOR_ENABLED` | **`true`** (default in `config.py`) | Live path uses `app/orchestrator/` |
| `VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED` | **`true`** | One-release safety net |
| `.env.example` | Updated to `true` | Aligns docs with code default |

**Live dispatch path:**  
`conversation_relay.dispatch_assembled_turn` → `turn_dispatch.dispatch_turn` → `OrchestratorRuntime.handle_turn`

---

## Fallback Behavior

When `VOICE_ORCHESTRATOR_ENABLED=true` and orchestrator raises:

1. If `VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED=true` → falls back to `llm_tool_runtime` for that turn only; logs `orchestrator_fallback`.
2. If fallback disabled → exception propagates (fail loud).

Fallback is wired in `app/ws/turn_dispatch.py` and now used by the live ConversationRelay path.

Enterprise tests confirm:
- Fallback activates only when explicitly enabled (`test_step4_enterprise.py`)
- No fallback when `VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED=false`

---

## Old Runtime Removal Recommendation

**Recommendation: Option A — keep `llm_tool_runtime` for one release as fallback**

| Factor | Assessment |
|--------|------------|
| Parity tests | 15/15 pass |
| Enterprise tests | All pass |
| Step 2 protections | Unchanged (payment gates, privacy, Redis, WS auth) |
| Fallback usage in prod | Monitor `orchestrator_fallback` log events for 2–4 weeks |
| Removal readiness | After zero fallback events in staging + prod for 14 days |

**Do not delete `llm_tool_runtime` yet.** After one stable release:

1. Generate migration report from production logs (fallback count, latency comparison)
2. Archive to `archive_legacy/` following Step 1 pattern
3. Remove `VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED` flag

---

## Files Changed (Step 4)

| Area | Key files |
|------|-----------|
| Dispatch | `app/ws/conversation_relay.py`, `app/ws/turn_dispatch.py` |
| Config | `app/config.py`, `.env.example` |
| Performance | `app/orchestrator/model_router.py`, `app/observability/turn_latency.py` |
| Memory | `app/memory/memory_manager.py`, `app/memory/postgres_store.py` |
| Observability | `app/observability/otel.py`, spans in shopify/openai/ws |
| Tests | `test_step4_orchestrator_parity.py`, `test_step4_enterprise.py` |
| Updated | `test_v418_llm_tool_runtime.py` (dispatch routing test) |

---

## Sign-off Checklist

- [x] Parity tests pass (15 scenarios)
- [x] Orchestrator default enabled
- [x] Legacy fallback wired and tested
- [x] 489 tests passing (457 baseline + 32 new Step 4 tests)
- [x] Step 2 hardening protections verified unchanged
- [ ] Staging live-call shadow comparison (recommended before prod cutover)
- [ ] Monitor fallback rate in production for one release cycle
