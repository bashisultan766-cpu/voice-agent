# Legacy Voice Commerce Runtime

Pre-V2 code remains in its original packages. **Do not import from `voice_os_v2` into these modules.**

## Active legacy paths (frozen when `VOICE_OS_V2_ENABLED=true`)

| Area | Location |
|------|----------|
| Live turn handler (v1) | `app/runtime/voice_commerce_runtime.py` |
| Payment / email FSM | `app/payment/payment_state_machine.py` |
| Commerce FSM | `app/agent_runtime/commerce_flow_state.py` |
| Order FSM | `app/agent_runtime/order_flow_state.py` |
| Escalation FSM | `app/agent_runtime/not_found_escalation_flow.py` |
| Conversation state machine | `app/agent_runtime/conversation_state_machine.py` |
| Tool registry + gates | `app/agent_runtime/llm_tools.py`, `tool_runtime_gates.py` |
| WebSocket (shared) | `app/ws/conversation_relay.py` |

## V2 replacement

Production rebuild: **`app/voice_os_v2/`** (`VOICE_AGENT_OS_V2`)

Enable with environment variable:

```
VOICE_OS_V2_ENABLED=true
```

When enabled, `turn_dispatch` routes to V2 only. Legacy FSMs are not invoked.

## Archive

Older pipeline code: `archive_legacy/2026_06_26_architecture_cleanup/`
