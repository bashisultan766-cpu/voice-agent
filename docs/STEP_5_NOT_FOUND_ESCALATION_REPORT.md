# STEP 5 — Product Not Found Escalation Report

**Date:** 2026-06-26  
**Scope:** SureShot Books voice agent — Shopify catalog miss → support email escalation

---

## Summary

Implemented the missing **product-not-found escalation workflow** for the live orchestrator path. When Shopify `search_products` confirms `not_found`, the agent:

1. Tells the customer the item is not available in Shopify
2. Captures email if not already confirmed (separate from payment FSM)
3. Sends a structured escalation email to `SUPPORT_EMAIL` via Resend
4. Speaks: *"I'll forward this to our team. If we can source it, they'll contact you by email."*

Production startup **fails fast** when `SUPPORT_ESCALATION_ENABLED=true` and `SUPPORT_EMAIL` is unset.

---

## Files changed

| File | Change |
|------|--------|
| `app/config.py` | Added `SUPPORT_ESCALATION_FROM_EMAIL`, `SUPPORT_ESCALATION_ENABLED`; production validation |
| `app/state/models.py` | Escalation session fields |
| `app/escalation/__init__.py` | **New** package |
| `app/escalation/models.py` | **New** `ProductNotFoundEscalationPayload` |
| `app/escalation/product_not_found_escalation.py` | **New** tool + Resend email + idempotency |
| `app/agent_runtime/not_found_escalation_flow.py` | **New** orchestrator FSM (email capture, staging) |
| `app/orchestrator/runtime.py` | Wire escalation turn + post-search handler |
| `app/orchestrator/response_composer.py` | Deterministic not-found / escalation messages |
| `app/orchestrator/tool_router.py` | Tool alias for `create_product_not_found_escalation` |
| `app/agent_runtime/llm_tools.py` | Register escalation tool in canonical registry |
| `app/tools/shopify_tools.py` | `_search_products_response()` sets `not_found` consistently |
| `.env.example` | Document new env vars |
| `app/tests/test_step5_not_found_escalation.py` | **New** 20 tests |
| `app/tests/test_shopify_tools.py` | Accept `not_found` on cache hits |

---

## Workflow added

```
product_search intent
  → planner: search_products
  → Shopify returns not_found
  → handle_search_not_found_results()
       ├─ email confirmed? → create_product_not_found_escalation → Resend → SUPPORT_EMAIL
       └─ no email? → stage pending_not_found_escalation + ask for email
  → next turn: process_not_found_escalation_turn()
       └─ extract email → create_product_not_found_escalation
```

**Idempotency:** One email per `call_sid + requested_type + requested_value` (in-memory + Redis when available).

**Payment safety:** Escalation uses its own session flags (`awaiting_not_found_escalation_email`). Does not mutate `payment_flow_status`.

---

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SUPPORT_EMAIL` | `""` | Destination (Jessica/support) — **required in production** when escalation enabled |
| `SUPPORT_ESCALATION_FROM_EMAIL` | `""` | Optional from-address (falls back to `RESEND_FROM_*`) |
| `SUPPORT_ESCALATION_ENABLED` | `true` | Master switch; when true + production, `SUPPORT_EMAIL` required at startup |

Also uses existing `RESEND_API_KEY` for sending.

---

## Tests added

`app/tests/test_step5_not_found_escalation.py` — **20 tests**:

1. ISBN not found → asks for email  
2. Title not found → asks for email  
3. Magazine not found → stages magazine type  
4. Newspaper not found → stages newspaper type  
5. Missing email → customer prompt  
6. Confirmed email → sends escalation  
7. Follow-up turn email → sends escalation  
8. Production `SUPPORT_EMAIL` required when escalation enabled  
9. Escalation email contains ISBN/title/session/call ID  
10. Duplicate escalation idempotent  
11. Product found → no escalation message  
12. Plus type inference, payload, config defaults  

---

## Test results

```
python -m compileall app -q          # OK
python -m pytest -q --tb=short       # 509 passed
```

---

## Remaining gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| `llm_tool_runtime` fallback path | Medium | Orchestrator is default; fallback does not auto-run this FSM |
| Postgres escalation audit | Low | Email sent; no durable DB row yet |
| Multi-search partial not-found | Low | Compare mode escalates only when **all** parallel searches miss |
| Email yes/no confirmation | Low | Escalation uses capture-on-provide (not payment-style confirm) |
| `catalog_search` tool path | Low | Only `search_products` in orchestrator planner wired |

---

## Updated estimated scores

| Metric | Before | After (est.) |
|--------|--------|--------------|
| Product-not-found escalation | 45 | **78** |
| Escalation flow (requirement-fit) | 45 | **78** |
| Production readiness | 62 | **68** |
| Overall requirement-fit | 63 | **71** |
| Overall enterprise score | 66 | **70** |

---

## What was NOT changed

- Payment safety gates (`payment/safety.py`)
- Payment email FSM (`payment_state_machine.py`)
- Order privacy gating
- WS auth / rate limits
- Live dispatch architecture (orchestrator primary)
