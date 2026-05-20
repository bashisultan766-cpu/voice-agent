# Cursor prompts — file-by-file implementation

Ready-to-paste prompts for building the project one file at a time.

## How to use

1. **One file at a time:** Create the file at the path given (or open it if it exists).
2. **Paste the prompt** for that file into Cursor.
3. Ask Cursor to **write complete code** into the open file. Prefer: *"Write complete code directly into the currently open file. Do not explain. Do not give pseudo-code. Production-ready code only."*
4. Run in **backend-first order** (DTOs → service → controller → module), then test, then frontend.

## Available prompt sets

| File | Description |
|------|-------------|
| **stores-module-prompts.md** | Stores CRUD: DTOs, service, controller, module, stores table, create dialog, stores page. |

## Next (to add)

- **agents-module-prompts.md** — Agents CRUD + prompt versioning.
- **auth-module-prompts.md** — Auth guard, tenant, current user (when using Clerk or JWT).
- **twilio-inbound-prompts.md** — Twilio webhook, agent resolution, call session.
- **openai-realtime-prompts.md** — Realtime session, tool orchestrator, transcript.

## Master plan

See **docs/MASTER-BUILD-PLAN.md** for phases, module map, system rules, and weekly execution.
