# Cleanup Step 1 Report — Architecture Consolidation

**Date:** 2026-06-26  
**Scope:** Remove duplicate legacy runtimes; keep single live `llm_tool_runtime` path.  
**No secrets** are recorded in this document.

---

## 1. Branch / State

| Item | Value |
|------|--------|
| Workspace | `E:/Agents/shopify agent` |
| Git CLI | Not available in cleanup shell (branch/commit not captured) |
| Primary service | `services/twilio-voice-agent` |
| Archive root | `archive_legacy/2026_06_26_architecture_cleanup/` |

---

## 2. Test Baseline (before cleanup)

| Command | Result |
|---------|--------|
| `python -m pytest -q --tb=no` | **2174 passed**, 15 failed, 8 skipped |

Pre-existing failures included payment/email short-circuit and commerce flow tests (LLM-only mode).

---

## 3. Test Results (after cleanup)

| Command | Result |
|---------|--------|
| `python -m compileall app -q` | Pass |
| `python -m pytest -q --tb=no` | **419 passed**, **1 failed** |

**Remaining failure (pre-existing / unrelated to archive):**

- `test_shopify_tools.py::test_lookup_order_unverified_omits_items` — unverified order response includes `items` key.

**Tests moved to archive:** ~179 files under `archive_legacy/2026_06_26_architecture_cleanup/tests/` (legacy pipeline, workers, composer, brain, Eric runtime, scouts, prompt-pack tests).

**Live-runtime tests retained:** Twilio WS wiring, `llm_tool_runtime`, `llm_tools`, prefetch setup, commerce/payment regressions (v4.38–v4.44), Shopify tools, security, cart, memory, facility workers (via `facility/`), email FSM.

---

## 4. Confirmed Live Runtime Path

```
POST /voice/twilio/inbound  (api/twilio_voice.py)
    → TwiML ConversationRelay
WS  /voice/twilio/ws        (ws/conversation_relay.py)
    → voice/turn_assembler.py
    → agent_runtime/llm_tool_runtime.py
    → agent_runtime/llm_tools.py
    → tools/shopify_tools.py | payment/* | email/* | facility/*
    → shopify/client.py | Resend | Redis
    → ws/conversation_relay_sender.py → Twilio TTS
```

**Call-setup prefetch** (no longer via pipeline engine):

- `sync/call_setup_prefetch.py::prefetch_on_call_setup()`

**Runtime identity:**

- `agent_runtime/live_runtime.py::resolve_live_turn_handler()` → always `llm_tool_runtime`

---

## 5. Archived (moved to `archive_legacy/2026_06_26_architecture_cleanup/`)

### Application packages

| Path | Why |
|------|-----|
| `app/pipeline/` | Legacy RealtimePipelineEngine, regex router, worker→composer path |
| `app/workers/` | 35 deterministic workers (orchestrator path only) |
| `app/composer/` | MainLLMComposer single-LLM worker path |
| `app/brain/` | EricDialogueBrain JSON planner |
| `app/ai/` | `openai_agent.py`, legacy `system_prompt.py`, tool schemas |
| `app/domain/` | SureShot brain excerpts for composer |
| `app/agent_runtime_legacy/scouts/` | Speculative prefetch scouts |
| `app/agent_runtime_legacy/legacy_disabled/` | Quarantine manifest |
| ~47 `app/agent_runtime/*.py` files | EricAgentRuntime, supervisor, main_llm_agent, llm_first, prompt pack loaders, sales_flow, etc. |

### Data / prompts

| Path | Why |
|------|-----|
| `data/prompt_pack/` (6 files) | Duplicate Eric prompt pack — not loaded live |
| `data/eric_system_prompt.md` | Legacy single-file prompt |

### Other

| Path | Why |
|------|-----|
| `services/ttwilio-voice-agent/` | Typo duplicate service stub |

---

## 6. Kept (active code)

### Core runtime (`app/agent_runtime/` — 27 modules)

`llm_tool_runtime.py`, `llm_tools.py`, `master_prompt.py`, `live_runtime.py`, `openai_health.py`, `output_guardrails.py`, `commerce_flow_state.py`, `payment_flow_state.py`, `tool_progress.py`, `tool_runtime_gates.py`, `isbn_short_circuit.py`, `fast_greeting.py`, `turn_prefetch.py`, `call_memory_manager.py`, `memory_packet.py`, `runtime_identity.py`, `caller_identity.py`, `types.py`, `order_flow_state.py`, `order_parallel_enrichment.py`, `yes_engagement.py`, `conversation_state_machine.py`, `interruption_manager.py`, `knowledge_base.py`, `catalog_orderability.py`, `__init__.py`

### Extracted shared utilities (from pipeline)

| New location | Was |
|--------------|-----|
| `app/email/capture.py` | `pipeline/email_capture.py` |
| `app/email/speller.py` | `pipeline/email_speller.py` |
| `app/tools/isbn_validator.py` | `pipeline/isbn_validator.py` |
| `app/safety/response_guard.py` | `pipeline/response_guard.py` |
| `sync/call_setup_prefetch.py` | `pipeline/engine.prefetch_on_call_setup` |
| `facility/approval_worker.py` | `workers/facility_approval_worker.py` |
| `facility/restriction_worker.py` | `workers/facility_restriction_worker.py` |
| `facility/worker_result.py` | `workers/base.py` (WorkerResult only) |

### Unchanged business logic (preserved)

`payment/`, `cart/`, `tools/shopify_tools.py`, `shopify/`, `sync/`, `conversation/`, `caller/`, `state/`, `dialogue/` (greetings + DialogueState), `ws/`, `api/`, `security/`, `safety/`

### Single live prompt

- `app/data/agent_master_system_prompt.md`
- Documentation: `app/prompts/README.md`

---

## 7. Config Changes

Deprecated (defaults set to inactive / archived paths):

- `ERIC_PROMPT_PACK_ENABLED=false`
- `VOICE_LLM_BRAIN_ENABLED=false`
- `VOICE_BRAIN_ORCHESTRATOR_ENABLED=false`
- `VOICE_SPECULATIVE_PREFETCH_ENABLED=false`
- `VOICE_AGENT_RUNTIME_MODE=llm_tool_runtime` (unchanged; only mode)

`VOICE_LIVE_DISABLE_OPENAI_TOOLS` retained — blocks archived `run_agent_turn` if ever re-imported.

---

## 8. Risk Notes

| Risk | Mitigation |
|------|------------|
| Accidental import of archived code | Archived packages removed from `app/`; tests for legacy paths moved to archive |
| `dialogue/manager.py` still present | Used for greetings, DialogueState, spell-email helpers — not a second runtime |
| 179 archived tests | Run live subset: `pytest app/tests/test_v418*.py app/tests/test_v4*_live*.py` |
| `test_shopify_tools` failure | Pre-existing; not introduced by cleanup |
| Multi-instance deploy | Unchanged — still requires Redis |
| Restore archived code | Full tree under `archive_legacy/2026_06_26_architecture_cleanup/` |

---

## 9. Removed Duplicate Architecture Paths

1. ~~Worker → Composer → OpenAI (no tools)~~
2. ~~EricAgentRuntime supervisor path~~
3. ~~RealtimePipelineEngine dual path~~
4. ~~EricDialogueBrain + scouts speculative prefetch~~
5. ~~Eric prompt pack + `eric_system_prompt.md` loaders~~
6. ~~`openai_agent.run_agent_turn` on live WS path~~

---

## 10. Recommended Step 2 Tasks

1. Fix `test_lookup_order_unverified_omits_items` (Shopify tool privacy tier).
2. Trim `services/twilio-voice-agent/README.md` to describe only `llm_tool_runtime`.
3. Remove deprecated config keys entirely (after one release cycle).
4. Add CI job: `pytest` on retained suite + `runtime_identity_check`.
5. Optional: inline `dialogue/manager.py` spell-email into `email/speller` and shrink dialogue package.
6. Optional: Postgres call logging or remove `DATABASE_URL` from config.
7. Do **not** rebuild planner/router until Step 1 is deployed and stable.

---

## 11. Verification Commands

```powershell
cd services/twilio-voice-agent
.\.venv\Scripts\python.exe -m compileall app -q
.\.venv\Scripts\python.exe -m pytest -q --tb=no
.\.venv\Scripts\python.exe -m app.scripts.runtime_identity_check
```

Expected: compile clean; 419+ tests pass; runtime identity check passes on release branch.
