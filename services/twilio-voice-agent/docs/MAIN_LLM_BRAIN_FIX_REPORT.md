# Main LLM Brain Fix Report

**Date:** 2026-06-26  
**Service:** `services/twilio-voice-agent`  
**Runtime:** `voice_commerce_runtime` → `MainCommerceBrain`

---

## Root Cause — OpenAI BadRequestError

Production `BadRequestError` was caused by an **invalid JSON schema** in the tool registry:

| Field | Location | Problem |
|-------|----------|---------|
| `product_tags` | `classify_product_content_for_facility` in `llm_tools.py` | Registered as `[]` (empty list) instead of `{"type": "array", "items": {"type": "string"}}` |

OpenAI Chat Completions rejects function `parameters.properties.*` values that are not valid JSON Schema objects. The invalid schema was included in `llm_tools.tool_specs()` (37 tools). Even though `classify_product_content_for_facility` is not in the Main Brain allowlist, the full `tool_specs()` export was previously sent on every brain request — triggering `400 Bad Request` before any tool could run.

**Secondary issues fixed:**

- Oversized system prompt (master prompt + Eric rules duplicated) increased latency and token cost.
- No safe `BadRequestError` diagnostics in brain path.
- Fast classifier missing deterministic ISBN-offer prompt (`"Can I give you the ISBN?"`).
- Partial ISBN digit utterances not always routed to brain.
- Tool loop allowed 5 rounds (now 3 per spec).

---

## Files Changed

| File | Change |
|------|--------|
| `app/agents/openai_request_utils.py` | **New** — `format_openai_bad_request()`, `log_openai_bad_request()` |
| `app/agents/openai_tool_schema_adapter.py` | **New** — `get_main_brain_tool_specs()`, curated 16-tool allowlist |
| `app/agents/main_commerce_brain.py` | Compact Eric system prompt, schema-safe tools, 3-round loop, error handling |
| `app/runtime/tool_router.py` | `tool_specs_for_brain()` → adapter |
| `app/runtime/fast_classifier.py` | ISBN-offer instant reply, partial ISBN routing |
| `app/runtime/voice_commerce_runtime.py` | Improved OpenAI fallback message |
| `app/agent_runtime/llm_tools.py` | Fixed `product_tags` schema bug |
| `app/tests/test_main_commerce_brain.py` | **New** — 18 brain/schema/routing tests |

---

## New Brain Flow

```
Twilio turn
    ↓
normalize_speech_text
    ↓
email FSM (deterministic — no LLM)
    ↓
fast_classifier
    ├─ instant → speak (greeting, vague product, ISBN offer)
    ├─ ack_then_brain → speak ack + MainCommerceBrain
    └─ brain → MainCommerceBrain
            ↓
    build_messages (compact Eric prompt + live state + sanitized history)
            ↓
    OpenAI chat.completions (gpt-4o-mini / gpt-4o)
    tools = get_main_brain_tool_specs()  [16 safe tools]
            ↓
    tool loop (max 3 rounds)
        ├─ direct answer → finalize_response → speak
        └─ tool_calls → tool_router.execute_batch (parallel read-only)
                      → tool results back to LLM
            ↓
    finalize_response (payment guardrails, output guardrails)
            ↓
    speak to caller
```

**On OpenAI failure:** safe fallback — *"I'm having trouble checking that right now. Could you say the title or ISBN again?"* — never silence.

---

## Tool Schema Adapter

`get_main_brain_tool_specs()` exposes only:

- `search_products`, `catalog_search`, `get_product_details`
- `add_to_cart`, `update_cart`, `remove_from_cart`, `get_cart`
- `send_payment_link`
- `lookup_order_status`, `lookup_refund_status`
- `facility_policy_lookup`, `search_facility_policy`, `check_facility_content_allowed`, `explain_facility_restriction`
- `escalate_to_customer_service`, `create_product_not_found_escalation`

**Excluded:** `create_checkout` and 20+ ancillary tools (compare, FAQ, normalize_voice_intent, etc.).

Each schema is sanitized and JSON-serialized before the OpenAI request.

---

## Tests Added

`app/tests/test_main_commerce_brain.py` — 18 tests covering:

1. Main brain OpenAI request schema valid  
2. Tool schemas JSON serializable  
3. No duplicate tool names  
4. BadRequestError logs safe useful details  
5. "Game of Thrones" → `search_products`  
6. Tool result → final LLM answer  
7. Order number → `lookup_order_status`  
8. Refund without verification → asks for order/email  
9. Facility question → facility tool  
10. Payment without email → blocked by gate  
11. Confirmed cart + email → payment allowed  
12. Greeting → no LLM  
13. "I need a book" → no LLM  
14. "Can I give ISBN?" → no LLM  
15. ISBN digits → brain  
16. OpenAI failure → never silence  
17. Tool failure → never silence  
18. Final response word-limited  

---

## Test Results

```
python -m compileall app -q          # OK
python -m pytest -q --tb=short       # 738 passed
```

---

## Remaining Gaps

1. **Live OpenAI validation** — schema fix verified locally; production should confirm `openai_bad_request` logs stop after deploy.
2. **Master prompt** — no longer injected into brain path; safety rules live in compact Eric prompt + runtime gates. If policy text grows, consider sectioned injection with token budget.
3. **Partial ISBN STT** — classifier handles digit strings; turn assembler `turn_mode=isbn` path should remain wired for best accuracy.
4. **`classify_product_content_for_facility`** — schema fixed in registry but still excluded from brain; facility brain uses `check_facility_content_allowed` / `search_facility_policy`.
5. **Strong model routing** — facility/refund/multi-product still set `use_strong_model=True` in classifier; monitor latency.

---

## Production Test Phrases

| # | Caller says | Expected behavior |
|---|-------------|-------------------|
| 1 | Hello, brother. How are you? | Instant: greeting, no LLM |
| 2 | I need a book. | Instant: ask title/author/ISBN |
| 3 | Can I give you the ISBN number? | Instant: "Yes, please go ahead…" |
| 4 | 978… (full/partial digits) | Brain → `search_products` / `catalog_search` |
| 5 | I need the book Game of Thrones. | Ack + brain → product search |
| 6 | Check order number 1234. | Brain → `lookup_order_status` |
| 7 | Did I get a refund? | Brain asks order/email if missing |
| 8 | Send me the payment link. | Brain; gate blocks without confirmed email/cart |
| 9 | My email is john dot smith at gmail dot com. | Email FSM capture (deterministic) |
| 10 | Does this facility allow magazines? | Brain → facility policy tool |

---

## Safe Logging Example

On `BadRequestError`, logs include (no secrets/PII):

```
openai_bad_request sid=CA1234 purpose=main_commerce_brain model=gpt-4o-mini messages=4 tools=16 dupes=none schema_issues=0 role_issues=0 serializable=True msg='Invalid schema...'
```
