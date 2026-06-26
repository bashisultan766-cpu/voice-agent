# Real-Time Voice Fast-Path Fix Report

**Date:** 2026-06-26  
**Scope:** Twilio ConversationRelay live voice agent — latency and deterministic routing fixes from forensic audit.  
**Safety preserved:** payment FSM, order privacy, email FSM, facility policy, WS auth, rate limits.

---

## Summary

Six audit findings were addressed with targeted changes (no full rebuild). Deterministic responses now stream immediately to Twilio, vague product requests bypass OpenAI and Shopify, yes/no respects active workflows, debounce is reduced with safe immediate-emit exceptions, and double-greeting is eliminated when TwiML `welcomeGreeting` already spoke.

---

## Root Causes Fixed

| # | Issue | Root cause | Fix |
|---|-------|------------|-----|
| 1 | Outbound buffering | `ConversationRelayOutbound.engine_send` held all `last=False` tokens until a final empty `last=True` flush | `play_immediately` flag bypasses buffer; runtime sends single `last=True` + `play_immediately` for final replies |
| 2 | 380ms debounce | `VOICE_TURN_ASSEMBLER_DEBOUNCE_MS=380` on every normal fragment | Default **250ms**; immediate emit for greetings, vague products, yes/no (ISBN/email/order rules unchanged) |
| 3 | "I need a book" → supervisor LLM | `_PRODUCT` heuristic + `need` in title regex treated vague utterances as `product_search` | New `product_request_clarification` fast path with pattern table checked **before** specificity heuristics |
| 4 | Vague → Shopify | Planner always called `search_products` on `product_search` intent | `is_vague_product_request()` gate in planner; `product_request_clarification` returns clarification only |
| 5 | Yes/no → smalltalk | Bare yes/no classified as smalltalk before FSM context | `_yes_no_active_workflow()` runs before smalltalk; `active_workflow_yes_no` fast-path skips supervisor LLM |
| 6 | Double greeting | Agent repeated full SureShot intro after TwiML welcome | `twiml_greeting_spoken` + shortened `resolve_smalltalk_response` when TwiML already greeted |

---

## Files Changed

| File | Change |
|------|--------|
| `app/config.py` | `VOICE_TURN_ASSEMBLER_DEBOUNCE_MS`: 380 → **250** |
| `app/ws/conversation_relay_sender.py` | `play_immediately` on `engine_send` — flush buffer and deliver token now |
| `app/orchestrator/runtime.py` | Commerce FSM before supervisor; progress ack + `_stream` use `play_immediately` |
| `app/orchestrator/types.py` | Added `product_request_clarification` to `VALID_INTENTS` |
| `app/orchestrator/intent_router.py` | Vague product patterns, yes/no workflow guard, double-greeting smalltalk, fast-path flags |
| `app/orchestrator/planner_agent.py` | Skip Shopify on vague requests; handle `product_request_clarification` |
| `app/orchestrator/response_composer.py` | TwiML-aware smalltalk; skip LLM for clarification intent |
| `app/orchestrator/supervisor_agent.py` | Intent schema includes `product_request_clarification` |
| `app/voice/turn_assembler.py` | `_can_emit_immediately` for greetings, vague products, affirmatives |
| `app/tests/test_realtime_voice_fast_path.py` | **New** — 28 tests across all seven phases |

---

## Tests Added

### Phase 1 — Outbound streaming (`test_realtime_voice_fast_path.py`)
- `test_play_immediately_delivers_without_buffer_wait`
- `test_progress_ack_plays_before_final_response`
- `test_stream_single_last_true_message`

### Phase 2 — Generic product fast path
- Parametrized `test_never_needs_supervisor_llm` (8 utterances)
- `test_planner_skips_shopify_on_vague`
- `test_specific_title_still_searches`

### Phase 4 — Yes/no routing
- `test_yes_not_smalltalk_during_email_confirm`
- `test_yes_confirms_email_via_payment_fsm`
- `test_yes_not_smalltalk_during_commerce`
- `test_yes_adds_book_via_commerce_fsm`

### Phase 5 — Debounce
- `test_hello_emits_immediately`
- `test_vague_product_emits_immediately`
- `test_yes_emits_immediately`
- `test_isbn_holds_until_complete`
- `test_email_holds_until_complete`

### Phase 6 — Double greeting
- `test_twiml_greeting_shortens_smalltalk`
- `test_without_twiml_includes_brand`
- `test_composer_respects_twiml_greeting`

### Phase 7 — Latency assertions (mocked)
- `test_hello_under_50ms_no_openai`
- `test_i_need_a_book_under_50ms_no_openai_no_shopify`
- `test_yes_email_fsm_under_50ms`

**Verification:** `695 passed` (`python -m pytest -q --tb=short`)

---

## Expected Latency — Before vs After

Estimates for orchestrator path after turn assembly (post-STT), excluding network/TTS:

| Utterance | Before (typical) | After (typical) | Notes |
|-----------|------------------|-----------------|-------|
| `"Hello"` | ~380ms debounce + supervisor/composer LLM (~1–3s) | **<50ms** heuristic + immediate send | No OpenAI |
| `"I need a book"` | ~380ms + supervisor + Shopify search (~2–5s) | **<50ms** clarification only | No OpenAI, no Shopify |
| `"Yes"` (email FSM active) | ~380ms + misrouted smalltalk/supervisor | **<50ms** payment FSM | No OpenAI |
| Normal product title | ~380ms debounce + tools | ~250ms debounce + tools | Debounce only reduced |
| Complete ISBN | Immediate (unchanged) | Immediate | Safe |
| Partial email | Collection hold (unchanged) | Collection hold | Safe |

**End-to-end perceived latency** also improves because `play_immediately` removes artificial wait for short deterministic TTS payloads (previously buffered until turn end).

---

## Deterministic Fast-Path Responses (immediate send)

These use `play_immediately` and/or skip supervisor LLM:

- Smalltalk (with TwiML-aware shortening)
- Generic product clarification (`product_request_clarification`)
- Yes/no clarification (idle call only)
- Payment FSM prompts (via `process_payment_turn` short-circuit)
- Email FSM prompts
- Order verification prompts
- Product-not-found escalation prompts
- Progress ack before tool execution

---

## Remaining Commercial-Agent Gaps

1. **Composer LLM on complex tool results** — catalog hits with multiple variants still route through composer LLM unless further templated.
2. **Supervisor LLM on borderline intents** — utterances outside pattern tables with confidence &lt; 0.92 still hit GPT (~1.8s budget).
3. **Shopify tool latency** — specific title searches remain network-bound (2.5s tool timeout); prefetch/speculative scout not enabled by default.
4. **Streaming TTS tokenization** — full replies sent as one `last=True` chunk; no sub-sentence streaming to ElevenLabs for long answers.
5. **LLM tool runtime fallback** — legacy `llm_tool_runtime._stream` two-message pattern unchanged when orchestrator disabled.
6. **Barge-in repair** — interrupt handling adds variable latency on overlap turns.
7. **Facility policy RAG** — facility questions still invoke policy retrieval + optional LLM compose.

---

## How to Re-Verify

```bash
cd services/twilio-voice-agent
python -m compileall app -q
python -m pytest -q --tb=short
python -m pytest app/tests/test_realtime_voice_fast_path.py -v
```
