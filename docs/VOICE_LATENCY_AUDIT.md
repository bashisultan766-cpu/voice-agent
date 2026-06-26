# Voice Latency Audit

**Date:** 2026-06-26  
**Scope:** Orchestrator live path (`OrchestratorRuntime.handle_turn`)

---

## Pipeline stages (measured)

Logged via `app/observability/turn_latency.py` → `TurnLatency.log()`:

| Stage | Field | Typical before Step 10 | Notes |
|-------|-------|------------------------|-------|
| STT → turn dispatch | `stt_to_turn_ms` | 50–200 ms | Turn assembler debounce included |
| Turn debounce (normal) | config | **550 ms** | Merged STT fragments |
| Supervisor | `supervisor_ms` | 0–800 ms | Heuristic ~0 ms; LLM ~400–800 ms |
| Planner | `planner_ms` | **<5 ms** | Deterministic only (no LLM) |
| Tool execution | `tool_total_ms` | 200–2500 ms | Shopify/catalog dominant |
| Response composer | `response_composer_ms` | 0–1200 ms | LLM when not deterministic |
| **Total turn** | `total_turn_ms` | **1.5–4.5 s** | Tool + optional LLM |

---

## Configuration (before → after Step 10)

| Setting | Before | After |
|---------|--------|-------|
| `VOICE_TURN_ASSEMBLER_DEBOUNCE_MS` | 550 | **380** |
| `VOICE_ORCHESTRATOR_TOOL_PROGRESS_MS` | 400 | 400 (unchanged) |
| `VOICE_DIGIT_COLLECTION_SILENCE_MS` | 2500 | 2500 (unchanged) |
| Supervisor LLM skip threshold | 0.92 | 0.92 (expanded heuristics) |

---

## Slow paths identified

1. **Shopify product search** — `search_products` / catalog API (200–2000 ms)
2. **Order lookup** — verification + Shopify order API
3. **Facility policy tools** — cached JSON read (fast) but paired with composer LLM historically
4. **Supervisor LLM** — fired when heuristic confidence < 0.92 (order/facility/refund were borderline)
5. **Composer LLM** — fired when tool results lacked `customer_message` / deterministic mapping
6. **Normal speech debounce** — 550 ms added to every non-immediate utterance

---

## Step 10 mitigations

| Mitigation | Effect |
|------------|--------|
| Fast progress ack before tools | Perceived latency ↓ ~300–800 ms |
| Deterministic composer shortcuts | Removes 400–1200 ms composer LLM on structured results |
| Heuristic supervisor for ISBN/order/facility/refund | Removes supervisor LLM on obvious intents |
| Debounce 550 → 380 ms | −170 ms on normal merged speech |
| Voice style guard (2 sentences) | Shorter TTS playback time |
| Interrupt repair in orchestrator | Avoids full re-plan on "what?" / "repeat" |

---

## Subsystem notes

- **Facility lookup** — reads local JSON only; no live URL fetch
- **Payment FSM** — bypasses supervisor/planner; no generic progress ack
- **Legacy `llm_tool_runtime`** — still uses `tool_progress.py` when orchestrator disabled

---

## How to read logs

```
turn_latency handler=orchestrator call_sid=CAxxxx stt_to_turn_ms=120 supervisor_ms=2 planner_ms=1 tool_total_ms=890 response_composer_ms=0 total_turn_ms=1020
```

Progress ack sent separately (non-final WS token) before `tool_total_ms` window.
