# Implementation Modules
## Multi-Tenant AI Voice Agent SaaS — Production MVP

**Document Version:** 1.0  
**Date:** March 6, 2025  
**Role:** Senior SaaS Systems Engineer

---

## 1. Frontend Modules

| Module | Scope | Description |
|--------|--------|-------------|
| **F1 — App shell & auth** | MVP | Layout, navigation, auth guard, login/logout, tenant context from JWT/session. |
| **F2 — Tenant & user management** | MVP (minimal) | Tenant profile (read/edit name); user list and invite (if multi-user). Minimal for single-tenant MVP. |
| **F3 — Store management** | MVP | List stores, add store (Shopify connect/OAuth or manual domain + credential), edit, soft delete. Store status and connection health. |
| **F4 — Agent management** | MVP | List agents by store, create/edit/delete agent, enable/disable, set name/description. Link to prompt and phone config. |
| **F5 — Prompt & config editor** | MVP | Edit system prompt, personality, store context, tools-enabled toggles. Create new prompt version, set active version. |
| **F6 — Knowledge documents (FAQs)** | MVP | CRUD for knowledge docs per agent (FAQ, policy, branch info). Upload or paste; sort order; status (active/draft). |
| **F7 — Phone number management** | MVP | List Twilio numbers for tenant, assign number to agent, unassign. Show which agent uses which number. |
| **F8 — Call history & session list** | MVP | List call sessions (tenant or per-store/per-agent filter). Columns: time, agent, number, duration, status. Link to session detail. |
| **F9 — Session detail & transcript** | Later | Single call view: transcript, tool executions, duration, metadata. Optional playback placeholder. |
| **F10 — Dashboards & analytics** | Later | Charts: call volume over time, by agent/store, success rate, tool usage. Export. |
| **F11 — Audit log viewer** | Later | List audit events (who did what, when). Filter by resource type, user, date. |
| **F12 — Settings & integrations** | MVP (minimal) | Tenant-level: Twilio account connection (SID + token ref), OpenAI key ref. Later: billing, webhooks. |

---

## 2. Backend Modules

| Module | Scope | Description |
|--------|--------|-------------|
| **B1 — Auth & tenant context** | MVP | Validate JWT/session; resolve `tenant_id` and optional `user_id`; attach to request context. Middleware for protected routes. |
| **B2 — Tenant API** | MVP | Read/update tenant profile. Optional: tenant creation (if multi-tenant signup). |
| **B3 — User API** | MVP (minimal) | List users for tenant, invite (send link or create placeholder). Role assignment. Minimal for single-tenant. |
| **B4 — Store API** | MVP | CRUD stores; validate tenant owns store. Store credential ref (write only from backend after OAuth or secure input). |
| **B5 — Agent API** | MVP | CRUD agents; list by store; enable/disable; set `currentPromptVersionId`. Enforce tenant via store. |
| **B6 — Prompt version API** | MVP | Create new version from agent, update content (system prompt, personality, tools, store context), set status (draft/active), list versions. |
| **B7 — Knowledge document API** | MVP | CRUD knowledge docs per agent; filter by type/status; sort order. |
| **B8 — Phone number API** | MVP | List Twilio numbers for tenant; assign/unassign to agent. Validate number belongs to tenant (sync from Twilio or store in DB). |
| **B9 — Call session API** | MVP | List call sessions with filters (tenant, store, agent, date range). Get one by id. Pagination. All queries tenant-scoped. |
| **B10 — Session detail API** | MVP | Get call session by id with transcript and tool executions. Tenant-scoped. |
| **B11 — Webhook receiver (Twilio voice)** | MVP | HTTP endpoints for Twilio: incoming call, status callback, media stream (if used). Verify Twilio signature; create/update CallSession; delegate to voice runtime. |
| **B12 — Audit logging** | MVP | Middleware or service: on mutating actions (create/update/delete for stores, agents, prompts, numbers), write to AuditLog (tenant_id, user_id, action, resource_type, resource_id, metadata, ip, user_agent). |
| **B13 — Credential resolution** | MVP | Service to resolve `credentialRef` (StoreCredential, TenantIntegration) to actual secret from vault/env; used by voice runtime and sync. Never expose refs to frontend. |
| **B14 — Dashboards & analytics API** | Later | Aggregations: call count by day/agent/store, avg duration, tool usage counts. Time-range and tenant-scoped. |
| **B15 — Audit log API** | Later | List audit logs with filters; tenant-scoped; pagination. |

---

## 3. Voice Runtime Modules

| Module | Scope | Description |
|--------|--------|-------------|
| **V1 — Call routing** | MVP | On incoming webhook: resolve agent from `To` number (DB or Redis cache). Load agent + store + current prompt version. Create CallSession (RINGING). Return TwiML (answer, connect stream or gather). |
| **V2 — Session state** | MVP | In-memory or Redis: map `twilio_call_sid` → agent_id, store_id, tenant_id, prompt_version_id. Used for subsequent webhook events (media, status). |
| **V3 — STT/LLM/TTS pipeline** | MVP | Receive audio (from Twilio stream or async); run STT (OpenAI Whisper or Twilio); build messages from transcript; call LLM (OpenAI) with agent prompt + tools; run TTS; stream or return audio to Twilio. |
| **V4 — Tool registry & execution** | MVP | Registry of tools (inventory, orders, store hours, policies, etc.). Per agent, only run tools in `toolsEnabled`. Each tool receives store context and credentials (resolved via B13). Log to ToolExecution. |
| **V5 — Knowledge injection** | MVP | For each request, inject agent’s knowledge documents (FAQs, etc.) into context (e.g. system message or RAG snippet). Filter by agent and status=active. |
| **V6 — Call lifecycle** | MVP | On hangup/status callback: update CallSession (status, endedAt, durationSeconds). Persist transcript if not already. Clean session state. |
| **V7 — Config cache** | MVP | Cache agent config (prompt version, tools, store ref) in Redis by agent_id; TTL e.g. 5–15 min. Invalidate on prompt/agent/phone change. Reduce DB load per call. |
| **V8 — Realtime / streaming** | Later | Optional: use OpenAI Realtime API or similar for lower-latency turn-taking. |
| **V9 — Fallback & error handling** | MVP | On LLM/tool timeout or failure: play fallback message (“I’m having trouble; please try again or call back”). Log error; set CallSession status to FAILED if appropriate. |

---

## 4. Integration Modules

| Module | Scope | Description |
|--------|--------|-------------|
| **I1 — Twilio client** | MVP | Wrapper for Twilio SDK: answer call, TwiML, start stream, send audio. Use tenant’s Twilio creds (from TenantIntegration via B13). |
| **I2 — OpenAI client** | MVP | Wrapper for OpenAI API: chat completion, optional Whisper (STT), TTS. Use tenant or platform key (from TenantIntegration or env). |
| **I3 — Shopify client** | MVP | Per-store client: products, orders, shop info (hours, policies). Use StoreCredential via B13. Rate limit and backoff per store. |
| **I4 — Shopify sync worker** | Later | Job: for each store, fetch products/orders/store config; write to DB or cache (e.g. store_product_cache). Schedule or webhook-triggered. Reduces real-time Shopify calls in tools. |
| **I5 — Auth provider (IdP)** | MVP | OAuth2/OIDC integration (e.g. Auth0, Okta): login, callback, JWT validation, map claims to tenant_id and user_id. |
| **I6 — Secrets / vault** | MVP | Read credentials by ref (e.g. vault path). Used by B13. Can be env vars for MVP, then vault. |

---

## 5. Analytics Modules

| Module | Scope | Description |
|--------|--------|-------------|
| **A1 — Call session logging** | MVP | Every call creates/updates CallSession; transcript and ToolExecution rows. Foundation for all analytics. |
| **A2 — Metrics emission** | MVP | Emit metrics (e.g. Prometheus/CloudWatch): call_count, call_duration_seconds, tool_execution_count, errors. Dimensions: tenant_id, agent_id, store_id. |
| **A3 — Aggregation queries** | Later | Pre-aggregate or on-demand: calls per day/agent/store, avg duration, tool usage. Power F10 and B14. |
| **A4 — Export & reporting** | Later | Export call history (CSV/Excel), scheduled reports. |
| **A5 — Real-time dashboards** | Later | Live call count, queue depth (if applicable). |

---

## 6. Suggested Build Order

Phases are ordered so that dependencies are available and the team can deliver a thin but complete flow early.

| Phase | Modules | Goal |
|-------|---------|------|
| **P0 — Foundation** | B1, B13, I5, I6, F1, (B2 minimal) | Auth works; tenant context; credential resolution; app shell and login. |
| **P1 — Core data & API** | B4, B5, B6, B7, B8, F3, F4, F5, F6, F7, F12 (minimal) | Stores, agents, prompt versions, knowledge docs, phone numbers manageable from UI. APIs tenant-scoped. |
| **P2 — Voice path** | I1, I2, I3, V1, V2, V3, V4, V5, V6, V7, V9, B11 | Inbound call → resolve agent → run STT/LLM/TTS and tools → persist session and transcript. |
| **P3 — Call history & ops** | B9, B10, B12, A1, A2, F8 | Call session list and detail; audit log write; basic metrics. |
| **P4 — Polish & scale** | Config cache tuning, error handling, F9 (session detail UI) | Session detail view; cache invalidation; fallbacks. |
| **Later** | F10, F11, B14, B15, A3, A4, A5, I4 | Dashboards, audit viewer, analytics API, sync worker, exports. |

**In one line:**  
P0 → P1 → P2 → P3 → P4, then Later.

---

## 7. Dependencies Between Modules

```
                    ┌─────────────────────────────────────────────────────────────────┐
                    │  P0 — Foundation                                                 │
                    │  B1 (Auth) ◄── I5 (IdP)   B13 (Creds) ◄── I6 (Vault)   F1 (Shell)│
                    └───────────────────────────────┬─────────────────────────────────┘
                                                    │
                    ┌───────────────────────────────▼───────────────────────────────────┐
                    │  P1 — Core data & API                                            │
                    │  B4 Store ◄── B1   B5 Agent ◄── B4   B6 Prompt ◄── B5   B7 Docs   │
                    │  B8 Phones ◄── B1,B5   F3,F4,F5,F6,F7,F12 ◄── B* APIs             │
                    └───────────────────────────────┬───────────────────────────────────┘
                                                    │
                    ┌───────────────────────────────▼───────────────────────────────────┐
                    │  P2 — Voice path                                                 │
                    │  I1 Twilio, I2 OpenAI, I3 Shopify ◄── B13                        │
                    │  V1 Routing ◄── B11, B8 (phone→agent)   V2 Session state          │
                    │  V3 Pipeline ◄── I2, V5   V4 Tools ◄── I3, B13   V5 Knowledge ◄── B7│
                    │  V6 Lifecycle   V7 Cache ◄── B5,B6   V9 Fallback   B11 Webhook   │
                    └───────────────────────────────┬───────────────────────────────────┘
                                                    │
                    ┌───────────────────────────────▼───────────────────────────────────┐
                    │  P3 — Call history & ops                                         │
                    │  B9,B10 Session API ◄── B1   B12 Audit ◄── B1   A1,A2   F8       │
                    └───────────────────────────────────────────────────────────────────┘
```

**Critical dependency list:**

| Module | Depends on |
|--------|------------|
| All backend APIs | B1 (tenant context) |
| B13 Credential resolution | I6 (vault/env) |
| B5 Agent API | B4 Store API (store exists, tenant owns it) |
| B6 Prompt API | B5 (agent exists) |
| B7 Knowledge API | B5 (agent exists) |
| B8 Phone API | B1, B5 (assign to agent) |
| B11 Twilio webhook | V1 (routing), V6 (lifecycle) |
| V1 Call routing | B8 / DB or cache (phone → agent), B5/B6 (config) |
| V3 Pipeline | I2 (OpenAI), V5 (knowledge) |
| V4 Tools | I3 (Shopify), B13 (store creds) |
| V5 Knowledge | B7 / DB (knowledge docs) |
| V7 Config cache | B5, B6 (invalidate on change) |
| B9/B10 Call session API | CallSession/Transcript/ToolExecution (written by V*) |
| B12 Audit | B1 (user/tenant), called from B4–B8 on mutations |
| F* (all frontend) | Corresponding B* APIs, F1 (auth/shell) |

---

## 8. MVP vs Later Phase

| Module | MVP | Later |
|--------|-----|-------|
| **Frontend** | F1, F3, F4, F5, F6, F7, F8, F12 (minimal) | F2 (full tenant/user mgmt), F9 (session detail), F10 (dashboards), F11 (audit viewer) |
| **Backend** | B1–B13, B9–B12 | B14 (analytics API), B15 (audit log API), full B2/B3 if multi-tenant signup |
| **Voice** | V1–V7, V9 | V8 (realtime/streaming) |
| **Integration** | I1, I2, I3, I5, I6 | I4 (Shopify sync worker) |
| **Analytics** | A1 (session logging), A2 (metrics) | A3 (aggregations), A4 (export), A5 (real-time dashboards) |

**MVP scope in one sentence:**  
Tenant can log in, manage stores/agents/prompts/knowledge/phone numbers, receive inbound calls that are answered by the right agent using OpenAI and Shopify tools, and view a list of call sessions with basic metrics and audit logging; credentials are refs resolved server-side.

**Later phase adds:**  
Richer tenant/user management, session detail and transcript viewer, dashboards and analytics API, audit log viewer, Shopify sync worker, export/reporting, and optional real-time/streaming voice improvements.
