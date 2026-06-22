# Deployment Ready Report — Twilio ConversationRelay Voice Agent

## v4.3 — Professional Dialogue Intelligence (2026-06-22)

### Status: READY FOR DEPLOYMENT

### Test Results

```
816 passed in ~36s
0 failed
0 errors
All mocked — no live API calls required
```

### Changes in v4.3

| Feature | Files |
|---------|-------|
| **DialogueManager** — flow state, clarifications, memory | `app/dialogue/manager.py`, `states.py` |
| Vague book request → ask ISBN/title/author/subject (no search) | `app/pipeline/router.py`, `response_plan_worker.py` |
| Cart/ISBN memory ("how many ISBN?", titles one by one) | `app/cart/ledger.py`, `cart_memory_worker.py` |
| Email spell/readback | `spell_email_worker.py`, router `spell_email_request` |
| Stronger email fragment assembly (multi-turn) | `app/pipeline/engine.py` |
| Payment end-to-end on final confirmation | `payment_flow_worker.py` |
| Composer rich context (flow, cart, email stage) | `app/composer/main_llm_composer.py` |
| Safe dialogue logging | `app/pipeline/engine.py`, `dialogue/manager.py` |
| 27 new tests | `test_v43_dialogue.py`, `test_v43_cart_payment.py` |

### Architecture preserved

- OpenAI tool-calling **disabled** in live voice
- Workers **never** call OpenAI
- `MainLLMComposer` final-only
- `PaymentSafetyGuard` unchanged
- Privacy masking unchanged

---

## v4.1.1 — Global Payment Safety Guard (2026-06-22)

### Status: READY FOR DEPLOYMENT

### Test Results

```
660 passed in ~22s
0 failed
0 errors
All mocked — no live API calls required
```

### Changes in v4.1.1

**Problem fixed:** `send_payment_link_email_tool` (LLM fallback path) accepted the raw email argument from the LLM without checking `session.confirmed_email`. An LLM could send a payment link to an unconfirmed, pending, or even caller-rejected email address.

| Change | File |
|--------|------|
| **New** `PaymentSafetyGuard` — single enforcement point for all payment paths | `app/payment/safety.py` |
| `send_payment_link_email_tool` — refuses without confirmed_email; blocks rejected candidates | `app/tools/shopify_tools.py` |
| `create_checkout_link` — gates on confirmed cart (items, qty ≥ 1, variant_id); ignores unconfirmed LLM email arg; blocks rejected candidate emails | `app/tools/shopify_tools.py` |
| `CheckoutWorker` — uses `confirmed_email` instead of `caller_email` | `app/workers/checkout_worker.py` |
| `_apply_email_state` — stores rejected email candidates in `session.rejected_email_candidates` on `email_correction` intent | `app/pipeline/engine.py` |
| `SessionState` — added `rejected_email_candidates: list[str]` | `app/state/models.py` |
| 23 new tests for PaymentSafetyGuard and all payment paths | `app/tests/test_v411_payment_safety.py` |

### Security Properties of v4.1.1

- **No confirmed_email = no payment email send** — enforced in both worker path and LLM tool path
- **Rejected email candidates permanently blocked** — stored in `session.rejected_email_candidates`, checked by `validate_tool_email_arg` before any payment operation
- **LLM email args are never trusted** — `validate_tool_email_arg` validates against `confirmed_email`; mismatches block the send without revealing the confirmed email
- **Cart gating before checkout** — `require_confirmed_cart` verifies items exist, qty ≥ 1, variant_id set
- **No OpenAI import in payment module** — enforced by AST test
- **No full email in logs** — `_mask_email` used throughout

### PaymentSafetyGuard API (`app/payment/safety.py`)

| Function | Purpose |
|----------|---------|
| `get_confirmed_email(session)` | Returns `confirmed_email` or `None`; never returns `pending_email` |
| `require_confirmed_email(session)` | Checks confirmed_email; distinguishes confirmed/pending/rejected/absent |
| `require_confirmed_cart(session)` | Checks items, qty ≥ 1, variant_id |
| `require_payment_send_ready(session)` | Full gate: confirmed_email + checkout_url |
| `validate_tool_email_arg(arg, session)` | Validates LLM email arg against confirmed_email; blocks rejected candidates |

---

## v4.1 — Production Bug Fixes (2026-06-22)

### Status: READY FOR DEPLOYMENT

### Test Results

```
637 passed in ~18s
0 failed
0 errors
All mocked — no live API calls required
```

### Bugs Fixed in v4.1

| # | Bug | Files Changed |
|---|-----|---------------|
| 1 | Shopify GraphQL `metafields(identifiers:...)` invalid for Admin API | `app/shopify/graphql_queries.py` |
| 2 | **P0** Email sent to wrong address — now requires `confirmed_email` | `app/workers/payment_email_worker.py`, `app/pipeline/email_capture.py`, `app/state/models.py`, `app/pipeline/engine.py` |
| 3 | Router missing 11 production intents | `app/pipeline/router.py` |
| 4 | No facility/inmate workers | `app/workers/facility_*_worker.py` (4 new files), `app/workers/orchestrator.py` |
| 5 | RefundWorker missing shipping refund, item detail, reason/note | `app/workers/refund_worker.py` |
| 6 | System prompt: generic agent name, no facility context, no AI disclosure rule | `app/ai/system_prompt.py` |
| 7 | Phone number logged in full | `app/ws/conversation_relay.py` |
| 8 | Shopify `GET_ORDER_WITH_REFUNDS` missing note/tags/shipping/adjustments | `app/shopify/graphql_queries.py` |

### New Files

| File | Purpose |
|------|---------|
| `app/pipeline/email_capture.py` | Spoken→typed email normalizer + confirmation state machine |
| `app/workers/facility_approval_worker.py` | Checks facility approval from order tags/notes |
| `app/workers/facility_restriction_worker.py` | Returns book restrictions for a facility |
| `app/workers/facility_policy_notes_worker.py` | Returns facility shipping policy notes |
| `app/workers/order_facility_review_worker.py` | Reviews order for facility-related issues |
| `app/tests/test_v41_email_capture.py` | 28 tests for email normalizer + state machine |
| `app/tests/test_v41_facility_workers.py` | 18 tests for 4 facility workers |
| `app/tests/test_v41_router_intents.py` | 27 tests for new router intents |
| `app/tests/test_v41_refund_worker.py` | 8 tests for enhanced RefundWorker |
| `app/tests/test_v41_privacy_logging.py` | 18 tests for phone/email masking and system prompt |

### Security Verification

- [x] `confirmed_email` is the ONLY email used for payment sends
- [x] `pending_email` never used for sends — only after caller says "yes"
- [x] Phone numbers in all logs masked to last-4: `***XXXX`
- [x] Email addresses in all logs masked: `a***@domain.com`
- [x] No raw Shopify JSON passed to LLM
- [x] Refund note: blocklist rejects SSN/card/routing numbers
- [x] Facility workers: never guess approval — return "unknown" if no data
- [x] All sensitive order/refund data gated behind `requires_verification`
- [x] Workers still do not import `openai` (AST test enforces this)
- [x] Single-LLM rule preserved: only `app/composer/main_llm_composer.py` calls OpenAI

### Not Changed (intentional)

- Twilio ConversationRelay transport: unchanged
- FastAPI app structure: unchanged
- WorkerOrchestrator architecture: unchanged (4 new workers added, no structural change)
- v4.0 test suite: all 526 original tests still pass

---

## v4.0 — Worker-First Pipeline (2026-06-21)

### Status: SUPERSEDED BY v4.1 (preserved for history)

```
526 passed
0 failed
```

Changes: Single-LLM composer, 13 async workers, WorkerOrchestrator, dual-path engine, ProductCache integration, VOICE_SHOPIFY_TIMEOUT_MS precedence.
