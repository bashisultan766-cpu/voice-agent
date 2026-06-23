# Voice Agent Architecture v4.13

## Overview

v4.13 adds a **Hard Conversation State Machine** and **LLM Action Gate** on top of the v4.12 LLM-Natural Final Speaker runtime. Prompts control tone and policy; runtime code controls turn-taking, worker execution, and repair behavior.

## Core Principle

**Prompt controls behavior and style — not turn-taking.**

Turn-taking, collection modes (ISBN, email, order), interrupt repair, and product search gating must be implemented in deterministic Python runtime code. ConversationRelay delivers text tokens; the runtime must maintain correct state between prompts.

## Prompt Storage (Part 1)

Eric's full system prompt lives in `app/data/eric_system_prompt.md`, loaded via `app/agent_runtime/prompt_loader.py`.

| Env var | Default | Purpose |
|---------|---------|---------|
| `ERIC_SYSTEM_PROMPT_PATH` | `app/data/eric_system_prompt.md` | Path to prompt file |
| `ERIC_SYSTEM_PROMPT_VERSION` | `v1` | Version label for ops checks |

If the file is missing, the runtime falls back to inline policy in `eric_master_policy.py`. Full prompt text is never logged or exposed via `/health`.

## Conversation State Machine (Part 2)

`app/agent_runtime/conversation_state_machine.py` tracks per-call state:

- **mode**: idle, small_talk, book_collection, isbn_collection, email_collection, order_collection, payment_flow, facility_flow, repair_mode
- **expected_next**, **active_task**, **pending_isbn_digits**, **frustration_count**, **last_safe_response**

The state machine classifies each utterance as task continuation, repair/repeat, new task, off-domain, interruption, invalid for current state, or keepalive.

Examples:
- ISBN collection exits on "Hello?", "Are you there?", frustration — not silent hold
- 10–12 digit ISBN partial timeout asks for the last digit
- "repeat again" clears ISBN buffer
- "wait" holds briefly; max hold sends keepalive
- Identity questions inside book flow answer identity without losing flow
- "What?" repeats `last_safe_response`

## LLM Action Gate (Part 3)

`app/agent_runtime/action_gate.py` runs **before workers**. No worker runs from router hint alone.

Product search is allowed only when:
- Valid ISBN
- Explicit phrases: "book called X", "title is X", "author is X", "do you have books about X"
- Active book-collection state with sufficient query specificity
- Customer selected a presented option

Product search is blocked for identity, frustration, generic, and unclear utterances. Blocked turns rewrite intent to identity/company/repeat/frustration/unknown — never call Shopify.

## Candidate Guard (Part 4)

`app/cart/candidate_guard.py` requires `action_gate_approved=True`. ProductSearchWorker refuses save when the gate blocked the search.

## Interrupt Repair (Part 5)

`app/agent_runtime/interruption_manager.py` handles ConversationRelay interrupts:

1. Stop sending old response
2. Store interrupted context
3. On next "What?" / "repeat" — answer from `last_safe_response`, not generic fallback
4. Do not run new product search on repair turns

## ISBN Collection (Part 6)

`app/voice/turn_assembler.py` + state machine:

| Env var | Default |
|---------|---------|
| `VOICE_ISBN_PARTIAL_TIMEOUT_MS` | 5000 |
| `VOICE_COLLECTION_MAX_HOLD_MS` | 7000 |
| `VOICE_COLLECTION_KEEPALIVE_ENABLED` | true |

Non-digit utterances are not merged into ISBN buffer unless they contain digits or explicit continuation words.

## Final LLM Speaker (Part 7)

`FinalResponseComposer` receives action gate context. Blocked product search routes to Final LLM with blocked reason — natural repair, not generic fallback.

## Defect Pattern Guard (Part 8)

`app/data/live_defect_patterns.json` + `defect_pattern_guard.py` — production safety net from live logs. Not a replacement for LLM; catches known ASR misroutes.

## Runtime Flow

```
ConversationRelay prompt
  → TurnAssembler (ISBN/email debounce)
  → EricAgentRuntime.handle_turn
      → Router hint (advisory)
      → LLM Supervisor
      → Interrupt repair check
      → ConversationStateMachine
      → Intent contract
      → ActionGate (block/allow workers)
      → DialogueManager / email / payment state
      → WorkerOrchestrator (deterministic)
      → FinalResponseComposer (LLM natural speaker)
      → ConversationRelay text send
```

## Non-Negotiables (Preserved)

- No OpenAI tool-calling in live path
- No `role="tool"`
- LLM never calls Shopify, Resend, Redis, or payment APIs directly
- Workers remain deterministic
- PaymentSafetyGuard, Processing Fee block, sanitizer unchanged
- v4.12 welcome greeting and ConversationRelay sender preserved

## Deployment Checklist

1. Set `ERIC_SYSTEM_PROMPT_PATH` and `ERIC_SYSTEM_PROMPT_VERSION`
2. Set ISBN/hold timeout env vars if non-default
3. Run `python scripts/check_agent_runtime.py` — verify prompt file loaded
4. Run full pytest suite
5. Live verify: identity turns must not trigger `product_search` or `product_candidate_saved`
