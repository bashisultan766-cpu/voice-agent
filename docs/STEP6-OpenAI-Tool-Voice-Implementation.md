# Step 6 — OpenAI Integration + Tool Calling + Shopify-Powered Voice Responses

**Scope:** Live call runtime uses OpenAI chat-with-tools: per-agent prompt, tool registry, tool execution loop, Shopify-ready tool stubs, fallback and handoff. Voice runtime processes user utterances and returns model + tool–driven replies.

---

## 1. What Was Implemented

### 1.1 Prisma

- **Agent:** `enabledTools` (Json), `maxToolCallsPerTurn` (Int), `handoffEnabled` (Boolean), `voiceResponseStyle` (String).
- **CallSession:** `openaiSessionId`, `endedReason`.
- **ToolExecution:** `requestId`.

Run: `pnpm --filter api prisma migrate dev --name step6_agent_tools_openai`

### 1.2 OpenAI Module (`apps/api/src/modules/integrations/openai/`)

| File | Purpose |
|------|--------|
| `openai.module.ts` | Exports prompt builder and tool registry. |
| `openai-prompt-builder.service.ts` | Builds final system prompt: store identity, agent prompt, commerce rules, tool usage, order verification, fallback/handoff. |
| `openai-tool-registry.service.ts` | Returns allowed tools for an agent; `getToolsForAgent(enabledTools)`, `isToolAllowed()`. |
| `openai-voice.service.ts` | `processTurn(callSessionId, userMessage, conversationHistory)` → OpenAI Chat Completions with tools, tool loop, returns `{ message, toolCallsCount, escalated }`. |
| `types/tool-definitions.ts` | JSON-schema–style definitions for: search_books, get_book_details, check_book_inventory, get_order_status, get_store_locations, get_shipping_policy, get_return_policy, create_callback_request, handoff_to_human. |

### 1.3 Tool Orchestrator (`calls/runtime/tool-orchestrator.service.ts`)

- Executes only tools allowed for the agent.
- Injects `tenantId` and `storeId` from session context (model does not send these).
- Stub implementations for all tools (Shopify/DB to be wired in Step 4 or later).
- Logs each execution to `ToolExecution` (input, output, status, latency).
- Returns normalized `ToolResult` for the model.

### 1.4 Voice Runtime

- **SessionContextService:** Agent now includes `enabledTools`, `maxToolCallsPerTurn`, `handoffEnabled`.
- **VoiceRuntimeService:** `processUtterance(callSessionId, text, conversationHistory)` uses `OpenAIVoiceService.processTurn()`, updates `escalated` on session when handoff tool is used.
- **VoiceRuntimeController:** `POST /api/calls/runtime/turn` body: `{ callSessionId, message, history? }` → `{ reply }`.

### 1.5 Flow

1. Caller speaks → text (e.g. from Twilio/STT) → `POST /api/calls/runtime/turn` with `callSessionId` and `message` (and optional `history`).
2. Runtime loads session context, builds prompt, gets allowed tools.
3. OpenAI Chat Completions with tools; if model returns tool_calls, orchestrator runs each tool (with injected context), logs to DB, appends tool results to messages.
4. Model produces final reply; optional escalation sets `escalated` on CallSession.
5. Response `reply` returned to caller (e.g. for TTS).

---

## 2. Tool List and Safety

| Tool | Purpose | Verification / notes |
|------|--------|----------------------|
| search_books | Product search | Stub; wire to Shopify. |
| get_book_details | Product details | Stub. |
| check_book_inventory | Inventory / location | Stub. |
| get_order_status | Order status | Requires order number + email or phone; prompt instructs model to ask. |
| get_store_locations | Branches / hours | Stub. |
| get_shipping_policy | Shipping policy | Stub. |
| get_return_policy | Return policy | Stub. |
| create_callback_request | Callback request | Stub; can write to DB later. |
| handoff_to_human | Escalation | Sets session `escalated`; uses agent escalation message. |

Order lookup: prompt says “Do not call get_order_status until you have order number and either email or phone.”

---

## 3. Env Variables (Step 6)

```env
OPENAI_API_KEY=
OPENAI_REALTIME_MODEL=gpt-4o-mini
TOOL_EXECUTION_TIMEOUT_MS=5000
MAX_TOOL_CALLS_PER_TURN=2
MAX_TOOL_CALLS_PER_CALL=12
```

---

## 4. Agent Configuration

- **enabledTools:** JSON array of tool names, e.g. `["search_books","get_order_status","get_store_locations"]`. If null/empty, all defined tools are allowed.
- **maxToolCallsPerTurn:** Max tool calls per model turn (default 2).
- **handoffEnabled:** Whether handoff_to_human is allowed.

---

## 5. Testing

- Create a CallSession (e.g. via Twilio inbound webhook).
- `POST /api/calls/runtime/turn` with `{ "callSessionId": "<id>", "message": "Do you have Harry Potter?" }` → should return a reply (tool may return stub “not connected yet”).
- Check `ToolExecution` rows for that call session.
- Optional: send `history` with previous `user`/`assistant` turns for multi-turn.

---

## 6. Implementation Order Used

1. Prisma: Agent (enabledTools, handoff, maxToolCallsPerTurn), CallSession (openaiSessionId, endedReason), ToolExecution (requestId).
2. Session context: agent.enabledTools and related fields.
3. Tool definitions and OpenAIToolRegistryService.
4. OpenAIPromptBuilderService.
5. ToolOrchestratorService (stubs + logging).
6. OpenAIVoiceService (chat with tools loop).
7. VoiceRuntimeService + controller (processUtterance, POST /turn).
8. CallsModule imports OpenAIModule, registers ToolOrchestrator and OpenAIVoiceService.

---

## 7. What’s Next (Step 7)

- Knowledge base + policies + RAG.
- Replace tool stubs with real Shopify/DB (product search, order status, locations, policies).
- Optional: OpenAI Realtime WebSocket for lower latency; current design uses Chat Completions so you can swap model or move to Realtime later.

---

## 8. Important Notes

- No auto refunds, cancellations, or write actions to Shopify in this step; read-only + safe support only.
- Store tokens and secrets stay server-side; model only sees tool names and caller-facing args; storeId/tenantId are injected in the orchestrator.
