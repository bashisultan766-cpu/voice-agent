# VOICE_AGENT_OS_V2.1

Production conversational voice core for SureShot Books.

## Pipeline (strict order)

```
TurnController.on_user_turn()
  1. acquire turn lock
  2. fetch Redis V2SessionState
  3. PolicyEngine.evaluate()        ← highest priority
  4. Planner.run()                ← rules + LLM (no state mutation)
  5. PolicyEngine.gate_tool_plan()
  6. ToolExecutor.run_chain()     ← max 3 steps
  7. ResponseComposer.build()     ← ONLY speech source
  8. VoiceEmitter.stream()        ← sentence-level, epoch-safe
  9. memory_contract commit       ← append-only logs
 10. release lock
```

## v2.1 production layers

| Layer | Module | Role |
|-------|--------|------|
| Policy | `policy_engine.py` | Payment/email/order/cart gates before planner |
| Trace | `trace_logger.py` | Per-turn latency + decision JSON |
| Memory | `memory_contract.py` | `turn_history`, `tool_history`, `state_transitions` |
| Tool chain | `tool_executor.py` | Up to 3 tools, planner followup only |

## Strict rules

- Only **ResponseComposer** generates customer speech
- **Planner** cannot mutate state (`state_patches` ignored from planner)
- **PolicyEngine** owns commit patches for commerce gates
- **Tools** cannot call other tools (chain via TurnController only)
- **TurnController** is the sole entry point

## Enable

```env
VOICE_OS_V2_ENABLED=true
```

Runtime mode: `voice_os_v2.1`

## Interrupt model

Flag-only in Redis — no task cancellation, no history rollback.

## Legacy

See `app/legacy/README.md` — FSMs not used when V2 enabled.
