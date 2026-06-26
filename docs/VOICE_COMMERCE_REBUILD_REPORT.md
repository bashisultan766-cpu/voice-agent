# Voice Commerce Rebuild Report

**Date:** 2026-06-26  
**Runtime:** `voice_commerce_runtime` (single-brain commerce agent)

## Summary

The live SureShot Books phone agent was rebuilt around one Main LLM Brain with deterministic fast paths only where safe. The fragmented orchestrator → supervisor → planner → composer pipeline is no longer the default live path.

## Old Broken Behavior Removed (from live path)

| Issue | Fix |
|-------|-----|
| Orchestrator supervisor/planner fighting the LLM | Replaced by `MainCommerceBrain` as sole decision-maker |
| Vague product requests triggering Shopify search | `fast_classifier` blocks search; instant clarification |
| Greetings routed through supervisor LLM | Instant deterministic replies, no LLM |
| `response_composer` bypassing brain for tool results | Brain produces all tool-assisted final speech |
| `VOICE_LLM_ONLY_FINAL_OUTPUT` skipping email FSM | Email capture/confirmation remains deterministic |
| Orchestrator default causing fragmented decisions | `VOICE_ORCHESTRATOR_ENABLED=False` by default |

Legacy orchestrator and `llm_tool_runtime` remain available via feature flags for fallback.

## New Live Runtime Path

```
Twilio ConversationRelay
  → turn_assembler
  → turn_dispatch
  → voice_commerce_runtime.handle_turn
       1. normalize_speech_text
       2. build live context (cart, email, payment, order state)
       3. fast_classifier (instant | ack_then_brain | brain)
       4. email FSM (deterministic capture/confirm/auto-send)
       5. MainCommerceBrain (OpenAI + tools)
       6. runtime/tool_router (parallel read-only tools, safety gates)
       7. output guardrails + payment/commerce enforcement
  → conversation_relay_sender → ElevenLabs/Twilio TTS
```

**Entry point:** `app/runtime/voice_commerce_runtime.py`  
**Dispatch:** `app/ws/turn_dispatch.py` (when `VOICE_COMMERCE_RUNTIME_ENABLED=True`)

## Main Brain Architecture

**File:** `app/agents/main_commerce_brain.py`

- **Fast model (default):** `OPENAI_FAST_MODEL=gpt-4o-mini` — normal commerce, search, cart, email, final speech
- **Strong model:** `OPENAI_STRONG_MODEL=gpt-4o` — multi-product, facility/refund complexity
- **System persona:** Eric, SureShot Books phone seller
- **Tool loop:** Up to 5 rounds; parallel dispatch for independent read-only tools
- **Never invents data** — all commerce facts from `llm_tools` → Shopify/facility/payment backends

## Fast Classifier

**File:** `app/runtime/fast_classifier.py`

| Class | Behavior |
|-------|----------|
| Greetings / smalltalk | Instant reply, no LLM, no tools |
| Vague product ("I need a book") | Clarification prompt, no Shopify |
| ISBN / title / author | Ack "Let me check that." → brain + tools |
| Order / refund | Ack → brain + Shopify tools |
| Active workflow yes/no | Routes to brain (email/cart/payment FSM) |

## Tools Exposed

Canonical registry unchanged: `app/agent_runtime/llm_tools.py`

Brain accesses tools via `app/runtime/tool_router.py` with:
- Payment safety gates (`gate_send_payment_link`)
- Cart gates (`gate_add_to_cart`)
- Order privacy gates
- Parallel execution for read-only tools
- Timeouts and transient retry

**Cart service:** `app/cart/commerce_cart_service.py` (wraps `CartLedger`)  
**Email capture:** `app/email/voice_email_capture.py` (wraps `email/capture.py` + speller)

## Payment Flow

1. Cart confirmed items in `CommerceCartService`
2. Spoken email → `VoiceEmailCapture.capture_from_speech`
3. Spell-back confirmation → customer says yes
4. `confirm_payment_email` → `payment_email_confirmed=true`
5. Auto-send (when `PAYMENT_AUTO_SEND_ENABLED`) → `send_payment_link` tool
6. Agent says: "I sent the payment link to your email. Please check your inbox."
7. Payment URL never spoken aloud

## Order / Refund Flow

- Brain calls `lookup_order_status`, `get_order`, `lookup_refund_status`, `calculate_pricing`
- Order number only → limited info
- Order + verified email/phone → full details
- Refund requires verification; never invents dates or amounts

## Facility Flow

- Brain calls facility tools (`search_facility_policy`, `answer_facility_policy_question`, etc.)
- Cached policy analysis + CSV fallback only — no live web scraping during calls
- Strong model used for complex facility explanations
- Low confidence → escalation

## Tests Added

**File:** `app/tests/test_voice_commerce_runtime.py` (22 scenarios)

Covers: greeting instant path, vague product clarification, specific search + tools, cart quantity/multi-item, email normalize/confirm/reject, active workflow yes/no, cart persistence on interrupt, order/facility routing, model selection, live handler identity.

## Test Results

```
python -m compileall app -q          # OK
python -m pytest -q --tb=short       # 718 passed
```

## Production Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `VOICE_COMMERCE_RUNTIME_ENABLED` | `true` | Enable single-brain runtime |
| `VOICE_ORCHESTRATOR_ENABLED` | `false` | Legacy orchestrator path |
| `VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED` | `true` | Fallback to llm_tool_runtime on crash |
| `OPENAI_FAST_MODEL` | `gpt-4o-mini` | Normal commerce turns |
| `OPENAI_STRONG_MODEL` | `gpt-4o` | Complex reasoning |
| `OPENAI_API_KEY` | required | Brain + tools |
| `SHOPIFY_*` | required | Product/order/refund data |
| `RESEND_*` | required | Payment link email |
| `VOICE_TOOL_TIMEOUT_MS` | `2500` | Per-tool timeout |
| `VOICE_OPENAI_TIMEOUT_MS` | `8000` | LLM timeout |

## Expected Latency

| Turn type | Target |
|-----------|--------|
| Greeting | <50ms (no LLM, no tools) |
| Vague product clarification | <50ms |
| Product search | Ack <100ms, then Shopify + brain |
| Order lookup | Ack <100ms, then Shopify + brain |
| Payment send | Deterministic FSM + Shopify draft + Resend |

## Remaining Limitations

1. **Product search tools** — Single `search_products` tool handles ISBN/title/author; dedicated `search_product_by_isbn` aliases not split (same backend).
2. **Orchestrator** — Still in codebase for certification; not live by default.
3. **Strong model routing** — Heuristic-based; may upgrade on multi-intent phrases only.
4. **SMS payment links** — Optional; email is primary channel.
5. **Live Shopify/Resend** — Integration tests marked `shopify_live` / `resend_live` excluded from default gate.

## Rollback

Set `VOICE_COMMERCE_RUNTIME_ENABLED=false` and `VOICE_ORCHESTRATOR_ENABLED=true` to restore orchestrator path, or disable both for `llm_tool_runtime` only.
