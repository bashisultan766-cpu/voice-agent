# LATEST REQUIREMENT-FIT & ENTERPRISE AUDIT

**Project:** SureShot Books — Twilio ConversationRelay Shopify Voice Agent  
**Audit date:** 2026-06-26  
**Auditor role:** Principal AI Voice Agent Architect / Enterprise SaaS Auditor  
**Scope:** Read-only analysis after architecture cleanup, Step 4 orchestrator promotion, and enterprise hardening  
**Evidence:** Code inspection + `489 passed` in `services/twilio-voice-agent/app/tests` (local run 2026-06-26)

---

# PART A — FULL ENTERPRISE AUDIT

---

## SECTION 1 — CURRENT PROJECT SUMMARY

### What the project does

A **phone-based AI sales and support agent** for SureShot Books (Shopify bookstore specializing in books, magazines, newspapers, and facility/inmate orders). Twilio handles STT/TTS via **ConversationRelay**; the Python FastAPI service exchanges plain-text JSON over WebSocket and orchestrates OpenAI + Shopify + Resend.

### Current live runtime path

```
POST /voice/twilio/inbound          → TwiML + signed WS URL
GET  /voice/twilio/ws               → ConversationRelay WebSocket
  → app/ws/conversation_relay.py
  → app/voice/turn_assembler.py     (debounce / ISBN-email-order modes)
  → app/ws/turn_dispatch.py
  → [default] app/orchestrator/runtime.py
       supervisor → planner → parallel_executor → tool_router → llm_tools
       → response_composer → output_guardrails → Twilio text tokens
  → [fallback] app/agent_runtime/llm_tool_runtime.py (on orchestrator exception)
```

**Config truth:** `VOICE_ORCHESTRATOR_ENABLED` defaults to **`True`** in `app/config.py` (Step 4 promotion). `README.md` still says default `false` — **stale**.

Entry: `app/main.py` → `handle_conversation_relay`. PM2: `ecosystem.config.cjs` (port 8001).

### Current architecture

| Layer | Active module | Status |
|-------|---------------|--------|
| Voice gateway | `api/twilio_voice.py`, `ws/conversation_relay.py` | Live |
| Turn assembly | `voice/turn_assembler.py` | Live |
| Orchestrator | `orchestrator/` (supervisor, planner, tool_router, parallel_executor, response_composer) | Live (default) |
| Tool surface | `agent_runtime/llm_tools.py` → `tools/shopify_tools.py` | Live (canonical) |
| Legacy LLM runtime | `agent_runtime/llm_tool_runtime.py` | Fallback only |
| Dead paths | `workers/orchestrator.py`, `pipeline/engine.py`, `agent_runtime/runtime.py`, scouts, brain | Present but not customer path |
| Session/memory | Redis `state/session_store.py`, `memory/memory_manager.py`, `conversation/call_memory.py` | Live |
| Postgres | `memory/postgres_store.py` | **Interface only — no schema/writes** |
| Shopify | `shopify/client.py`, `shopify/graphql_queries.py`, `sync/repositories.py` | Live |
| Email | `tools/email_sender.py`, Resend | Live |
| Facility | `facility/*` + placeholder data | **Partial — not production data** |

### Current test status

- **489 tests** in `services/twilio-voice-agent/app/tests`
- **489 passed** (17.3s local)
- CI: `.github/workflows/ci.yml` — pytest + compileall on push/PR
- Strong unit/regression coverage; **weak live-call / sandbox Shopify / voice E2E coverage**

### Current production readiness

**Conditionally deployable** for a controlled pilot (single store, monitored calls) if Redis, secrets, Shopify, Resend, and ElevenLabs voice ID are configured. **Not enterprise-ready** for scale, facility policy completeness, workflow audit, or full business escalation flows.

### Score summary (strict)

| Dimension | Score |
|-----------|-------|
| Architecture | 72 |
| Voice latency | 58 |
| AI agent design | 70 |
| Tool design | 78 |
| Shopify integration | 75 |
| Payment safety | 82 |
| Email capture | 76 |
| Memory | 55 |
| Security | 74 |
| Observability | 48 |
| Scalability | 52 |
| Maintainability | 58 |
| Production readiness | 62 |
| **Overall** | **66 / 100** |

---

## SECTION 2 — CURRENT LIVE ARCHITECTURE

### Exact active path (file-level)

1. **Twilio inbound webhook** — `app/api/twilio_voice.py`
   - Validates Twilio HMAC (`security/twilio_signature.py`)
   - Rate limit 120/min (`security/rate_limit.py`)
   - Mints WS token (`security/ws_token.py`)
   - Returns `<ConversationRelay>` TwiML with ElevenLabs voice string

2. **WebSocket** — `app/ws/conversation_relay.py`
   - WS token validation when enabled
   - Per-call `SessionState`, caller profile prefetch (≤750ms)
   - Interrupt handling (cancels in-flight turn task)
   - Outbound queue via `conversation_relay_sender.py`

3. **Turn assembler** — `app/voice/turn_assembler.py`
   - Debounce `VOICE_TURN_ASSEMBLER_DEBOUNCE_MS` (550ms default)
   - Modes: normal, isbn, email, order
   - Partial ISBN / keepalive / bare-affirm handling

4. **Dispatch** — `app/ws/turn_dispatch.py`
   - Orchestrator primary; `llm_tool_runtime` on exception if `VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED`

5. **Orchestrator** — `app/orchestrator/runtime.py`
   - Payment FSM short-circuits (`payment_flow_state.py`)
   - `MemoryManager.load()` → supervisor → planner → `execute_plan()` → `compose_response()`

6. **Supervisor** — `orchestrator/supervisor_agent.py`
   - Heuristic intent (`intent_router.py`) + optional fast LLM JSON

7. **Planner** — `orchestrator/planner_agent.py`
   - **Deterministic regex planner** (no LLM planner)
   - Maps intent → `PlanStep` list

8. **Parallel executor** — `orchestrator/parallel_executor.py`
   - Parallel read-only tools; sequential mutations

9. **Tool router** — `orchestrator/tool_router.py`
   - Gates via `tool_runtime_gates.py`
   - Dispatches to `llm_tools.dispatch()`

10. **Domain tools** — `tools/shopify_tools.py`, `tools/email_sender.py`, `facility/*`

11. **Response composer** — `orchestrator/response_composer.py`
    - Deterministic tool summaries + optional LLM compose

12. **Safety** — `output_guardrails.py`, `payment/safety.py`, `tool_runtime_gates.py`

13. **Memory** — `memory/memory_manager.py`, `conversation/call_memory.py`, Redis session store

### External services

| Service | Usage |
|---------|-------|
| Twilio | Inbound voice, STT, TTS (ElevenLabs via CR or Google fallback) |
| OpenAI | Supervisor (optional), composer, fallback `llm_tool_runtime` |
| Shopify Admin GraphQL | Catalog, orders, refunds, draft orders |
| Resend | Payment link email, escalation notification |
| Redis | Sessions, rate limits, product cache, payment idempotency |
| Postgres | **Configured hook only — not implemented** |

### Architecture diagram (text)

```
                    ┌─────────────────┐
                    │  Twilio PSTN    │
                    └────────┬────────┘
                             │ POST /voice/twilio/inbound
                             ▼
                    ┌─────────────────┐
                    │  TwiML + WS URL │
                    │ twilio_voice.py │
                    └────────┬────────┘
                             │ WSS ConversationRelay
                             ▼
┌──────────────────────────────────────────────────────────────┐
│              conversation_relay.py                           │
│  setup │ prompt │ interrupt │ dtmf                            │
└────────────┬─────────────────────────────────────────────────┘
             │
             ▼
┌────────────────────┐     ┌─────────────────────┐
│  turn_assembler    │────▶│  turn_dispatch      │
│  (550ms debounce)  │     │  orchestrator first │
└────────────────────┘     └──────────┬──────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
         ┌──────────────────────┐            ┌──────────────────────┐
         │ OrchestratorRuntime  │            │ LLMToolRuntime       │
         │ supervisor           │  fallback  │ (OpenAI tool loop)   │
         │ planner (regex)      │◀───────────│                      │
         │ parallel_executor    │            └──────────────────────┘
         │ tool_router          │
         │ response_composer    │
         └──────────┬───────────┘
                    │
     ┌──────────────┼──────────────┬─────────────┐
     ▼              ▼              ▼             ▼
┌─────────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐
│ Shopify │  │  Resend   │  │  Redis   │  │ Facility │
│ GraphQL │  │  email    │  │  session │  │ registry │
└─────────┘  └───────────┘  └──────────┘  └──────────┘
```

---

## SECTION 3 — WHAT IS STILL WRONG

| # | Issue | Severity | Files/folders | Why it matters | Fix |
|---|-------|----------|---------------|----------------|-----|
| 1 | **51 facility CSVs not ingested** — only 1 example facility | **Critical** | `app/data/facility_guidelines.json`, `facility_guidelines.csv`, `facility_docs/` | Business cannot answer real facility policy questions | Run ingest on all client CSVs/PDFs; validate count ≥51 |
| 2 | **Product-not-found escalation incomplete** — no structured email to Jessica/support with ISBN, phone, email, session ID | **Critical** | `tools/shopify_tools.py` (`_notify_support_escalation`, `EscalateToCustomerService`), `orchestrator/planner_agent.py` | Core seller promise unmet | Add `product_not_found_escalation` tool + planner branch on `not_found` |
| 3 | **Postgres persistence is a stub** | **High** | `memory/postgres_store.py` | No durable audit, replay, analytics | Implement schema + real writes |
| 4 | **Dual runtime paths** (orchestrator + llm_tool_runtime fallback) | **High** | `ws/turn_dispatch.py`, `agent_runtime/llm_tool_runtime.py` | Divergent behavior under failure | Certify orchestrator; disable fallback in prod |
| 5 | **~84 agent_runtime + workers + pipeline dead code in active tree** | **High** | `app/agent_runtime/*`, `app/workers/*`, `app/pipeline/*`, `app/brain/*` | Confusion, import risk, maintenance cost | Archive after grep-verified zero live imports |
| 6 | **README vs config mismatch** on orchestrator default | **Medium** | `README.md`, `config.py` | Ops misconfiguration | Align docs |
| 7 | **Orchestrator planner ignores multi_book_collector** | **High** | `planner_agent.py` vs `multi_book_collector.py` | Multi-product calls weak in live path | Wire multi-identifier planner steps |
| 8 | **3 sequential LLM calls possible per turn** (supervisor + composer + legacy) | **High** | `supervisor_agent.py`, `response_composer.py` | Latency 3–8s+ | Cache supervisor; deterministic composer for tool-heavy turns |
| 9 | **Turn debounce 550ms** | **Medium** | `turn_assembler.py`, `config.py` | Adds perceived delay | Tune to 300–400ms with A/B on live calls |
| 10 | **OTEL disabled by default** | **High** | `config.py`, `observability/otel.py` | Blind in production | Enable OTLP + dashboards |
| 11 | **No workflow replay / event store** | **High** | `orchestrator/` | Cannot debug production calls | Postgres turn + tool event tables |
| 12 | **Escalation email minimal** — no session ID, customer email, product requested | **High** | `shopify_tools.py:115-147` | Support team cannot act | Rich escalation payload template |
| 13 | **facility_docs_index.json empty** | **Critical** | `app/data/facility_docs_index.json` | PDF policy links unused | Run `ingest_facility_documents` |
| 14 | **Deprecated config flags still present** | **Low** | `config.py` lines 155-242 | Noise | Remove after flag audit |
| 15 | **No vector / semantic memory** | **Medium** | — | Long calls lose nuance | Rolling summary LLM + optional pgvector |
| 16 | **Weak live sandbox tests** | **High** | `app/tests/` | Regressions slip to production | Add Shopify sandbox integration suite |
| 17 | **Single uvicorn worker** | **Medium** | `ecosystem.config.cjs` | CPU-bound ceiling | Multi-worker + sticky sessions or Redis-only state |
| 18 | **Prompt pack + eric prompts duplicate master prompt** | **Medium** | `app/data/prompt_pack/`, `eric_system_prompt.md` | Drift risk | Delete unused; single `agent_master_system_prompt.md` |
| 19 | **Orchestrator `response_composer` has no not_found branch** | **High** | `response_composer.py:99-108` | Silent on empty search | Deterministic not-found + offer escalation |
| 20 | **SUPPORT_EMAIL / JESSICA_EMAIL optional** — escalation silently no-ops | **High** | `config.py`, `_notify_support_escalation` | Escalation appears to work but email never sends | Fail loud in prod if unset |

---

## SECTION 4 — WHAT SHOULD BE DELETED

| Item | Action | Reason | Risk |
|------|--------|--------|------|
| `archive_legacy/2026_06_26_architecture_cleanup/` (479 files) | **Keep archived** (delete from repo after 30-day validation) | Already quarantined | Low if git history kept |
| `app/agent_runtime/runtime.py`, `main_llm_agent.py`, `brain_orchestrator.py`, scouts/* | **Archive later** | Not in live dispatch path | Medium — verify imports |
| `app/workers/orchestrator.py`, `app/pipeline/engine.py` | **Archive later** | Legacy worker fan-out | Medium |
| `app/brain/eric_dialogue_brain.py` | **Archive later** | Superseded by orchestrator | Low |
| `app/data/prompt_pack/*`, `eric_system_prompt.md` | **Archive later** | `ERIC_PROMPT_PACK_ENABLED=false`; master prompt is canonical | Low |
| `app/composer/main_llm_composer.py` | **Archive later** | Legacy | Low |
| `VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED` | **Disable in prod** then remove | Hides orchestrator bugs | High if removed too early |
| Deprecated flags in `config.py` | **Delete later** | Ignored | Low |
| Duplicate tests in `archive_legacy/tests/` | **Delete now** from working tree | Already copied/active in app/tests | Low |
| `DEPLOYMENT_READY_REPORT.md` (stale) | **Archive** | Misleading if outdated | Low |

**Do NOT delete now:** `llm_tool_runtime.py` (certified fallback), `llm_tools.py`, `shopify_tools.py`, orchestrator package, payment safety modules.

---

## SECTION 5 — WHAT SHOULD BE IMPROVED (prioritized)

### 1. Voice speed and latency
| Priority | Recommendation | Impact |
|----------|----------------|--------|
| P0 | Skip supervisor LLM when heuristic confidence ≥0.92 (already partial — enforce always in prod) | +5 latency |
| P0 | Deterministic composer for search/order/refund tool results (skip composer LLM) | +8 latency |
| P1 | Reduce debounce to 350–400ms | +3 latency |
| P1 | Stream first progress token at 250ms (`VOICE_FILLER_AFTER_MS`) | +5 voice UX |
| P2 | Prefetch caller profile + catalog cache on `setup` (partial: `sync/call_setup_prefetch.py`) | +3 |

### 2. AI reasoning quality
| Priority | Recommendation | Impact |
|----------|----------------|--------|
| P1 | LLM planner only for ambiguous multi-intent turns | +6 agent design |
| P1 | Feed `MemoryManager.safe_summary` + last 3 facts to composer | +4 memory |

### 3. Tool execution
| Priority | Recommendation | Impact |
|----------|----------------|--------|
| P0 | Auto-chain: search → not_found → escalate_to_customer_service | +10 requirement-fit |
| P1 | Wire `multi_book_collector` into orchestrator planner | +7 multi-product |

### 4. Shopify product search
| Priority | Recommendation | Impact |
|----------|----------------|--------|
| P1 | Author/magazine/newspaper taxonomy via `catalog_taxonomy.py` in planner | +5 |
| P1 | Nightly catalog index sync job (document in runbook) | +4 reliability |

### 5. Payment link reliability
| Priority | Recommendation | Impact |
|----------|----------------|--------|
| P1 | Enforce `checkout_certifier.py` in prod deploy gate | +3 payment |
| P2 | Idempotency metrics on Redis payment keys | +2 |

### 6. Email capture
| Priority | Recommendation | Impact |
|----------|----------------|--------|
| P1 | ASR email repair already in turn_assembler — add regression live tests | +3 |

### 7. Long-term memory
| Priority | Recommendation | Impact |
|----------|----------------|--------|
| P0 | Implement Postgres turns + caller profiles | +12 memory |
| P2 | pgvector for past call retrieval | +5 returning callers |

### 8. Order/refund support
| Priority | Recommendation | Impact |
|----------|----------------|--------|
| P1 | Expose discount/tax fields from GraphQL in `lookup_order` | +4 |
| P2 | Carrier delivery ETA when Shopify provides | +2 |

### 9. Security
| Priority | Recommendation | Impact |
|----------|----------------|--------|
| P0 | Require SUPPORT_EMAIL + JESSICA_EMAIL in prod validation | +3 |
| P1 | Prompt-injection regression suite | +4 |

### 10. Observability
| Priority | Recommendation | Impact |
|----------|----------------|--------|
| P0 | Enable OTEL + turn latency dashboard (`turn_latency.py`) | +15 observability |

### 11. Scalability
| Priority | Recommendation | Impact |
|----------|----------------|--------|
| P1 | Horizontal scale guide: Redis-only state, Nginx WS sticky | +8 |

### 12. Testing
| Priority | Recommendation | Impact |
|----------|----------------|--------|
| P0 | Product-not-found escalation integration test | +5 |
| P1 | Live call simulation harness (`test_v4150_staging_voice_smoke_harness.py` expand) | +6 |

### 13. Deployment
| Priority | Recommendation | Impact |
|----------|----------------|--------|
| P0 | `runtime_identity_check` in CI + deploy gate (script exists) | +4 prod readiness |

---

## SECTION 6 — ELEVENLABS-STYLE AGENT GAP ANALYSIS

**What stops this from feeling like a premium ElevenLabs-style agent:**

| Blocker | Current problem | Required change | Files | Impact |
|---------|-----------------|-----------------|-------|--------|
| Turn latency stack | 550ms debounce + supervisor + tools + composer LLM | Collapse to 1 LLM or deterministic fast path | `turn_assembler.py`, `orchestrator/` | High |
| Non-streaming cognition | Text tokens sent after full turn processed | Early filler + partial token stream from composer | `conversation_relay_sender.py` | High |
| Tool silence | Progress only after 400ms | Immediate "checking catalog" on tool start | `runtime.py:181-190` | Medium |
| Robotic multi-question | Composer sometimes packs multiple asks | Enforce one-question guard in composer | `response_composer.py` | Medium |
| Interruption recovery | Task cancel works; context loss possible | Persist interrupted utterance in memory | `conversation_relay.py`, `interruption_manager.py` | Medium |
| Voice quality dependency | ElevenLabs only if `VOICE_ID` set | Document required prod vars | `config.py` | High for brand |
| Long-call drift | Rolling summary exists but shallow | LLM summarize every 10 turns | `call_memory_manager.py` | Medium |

---

## SECTION 7 — N8N-STYLE WORKFLOW GAP ANALYSIS

| Blocker | Current problem | Required change | Impact |
|---------|-----------------|-----------------|--------|
| No visual workflow | Code-only orchestration | Export turn plans as JSON event log | High |
| No replay | Cannot re-run a call's tool chain | Store PlannerResult + ToolExecutionResult per turn | High |
| Limited branching | Planner is regex intent → fixed steps | Conditional edges on tool results (e.g. not_found) | High |
| Retries | OpenAI retry only | Per-tool retry with backoff in `tool_router.py` | Medium |
| Human handoff | `escalate_to_human` logs + optional email | Twilio transfer or ticket ID | Medium |
| Audit trail | Debug logs only | Postgres `tool_events` table (hook exists) | High |
| Event triggers | Inbound call only | Shopify webhooks → proactive caller context (`sync/webhooks.py` partial) | Low |

---

## SECTION 8 — IDEAL TARGET ARCHITECTURE

```
┌─────────────┐
│Voice Gateway│ Twilio CR + WS auth + rate limits
└──────┬──────┘
       ▼
┌──────────────────┐
│Conversation Mgr  │ turn_assembler, interrupt, session lifecycle  ✅ EXISTS
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Supervisor Agent │ intent + risk  ✅ EXISTS (orchestrator/supervisor_agent.py)
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Planner Agent    │ deterministic + LLM for complex  ⚠️ PARTIAL (regex only)
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Tool Router      │ ✅ EXISTS
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Parallel Executor│ ✅ EXISTS
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Workflow Engine  │ branching, replay, retries  ❌ MISSING
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Domain Services  │ Shopify, facility, email  ✅ EXISTS
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Memory Manager   │ Redis live; Postgres stub  ⚠️ PARTIAL
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Response Composer│ ✅ EXISTS
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Evaluation Engine│ live log regressions only  ⚠️ PARTIAL
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Analytics/Tracing│ OTEL off; turn_latency logs  ⚠️ PARTIAL
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Deployment Layer │ PM2 + Nginx docs  ⚠️ PARTIAL (no blue/green)
└──────────────────┘
```

---

## SECTION 9 — MEMORY AUDIT

### Current state

| Type | Implementation | Location |
|------|----------------|----------|
| Short-term | Last N turns in session | `SessionState`, `call_memory.py` |
| Rolling summary | `CallMemoryManager` | `agent_runtime/call_memory_manager.py` |
| Session state | Cart, payment FSM, verified flags | `state/models.py`, Redis |
| Cart state | `cart/ledger.py` | Redis-backed session |
| Customer profile | `caller/repository.py` | Redis/optional DB |
| Call resume | 30-min window by phone | `session_store.load_call_resume_by_phone` |
| Postgres | Debug-only hooks | `memory/postgres_store.py` |
| Vector memory | **None** | — |

### Recommendations

**Long calls:** LLM rolling summary every 8–10 turns; cap history at 40 messages (already in `llm_tool_runtime`).

**Returning callers:** Persist `caller_profile` + last cart snapshot in Postgres; greet with name.

**Redis:** Hot session, cart, rate limits, Shopify search cache, payment idempotency keys.

**Postgres:** `calls`, `turns`, `tool_events`, `payment_links`, `escalations`, `caller_profiles`.

**Vector (optional):** Embed facility policy chunks + past escalation resolutions.

**Never store:** Full card numbers, raw OpenAI keys, unmasked PII in logs, payment URLs in spoken/logged form.

---

## SECTION 10 — PERFORMANCE / LATENCY AUDIT

| Source | Typical cost | Notes |
|--------|--------------|-------|
| Twilio STT | 200–800ms | External |
| Turn debounce | **550ms** | Configurable |
| Supervisor heuristic | 5–20ms | Fast path |
| Supervisor LLM | 300–1200ms | When confidence <0.92 |
| Planner | <5ms | Regex |
| Shopify tool | 200–2500ms | Cache hits <50ms |
| OpenAI composer | 400–2000ms | Every tool turn |
| TTS (ElevenLabs via CR) | 200–600ms | External |
| Redis | <10ms | |
| Postgres | N/A | Not used |

### Quick wins
- Deterministic composer for catalog/order/refund
- Heuristic-only supervisor in prod
- Debounce 350ms

### Medium
- Parallel tool batching (exists)
- ProductCache warm on deploy

### Advanced
- Speculative catalog prefetch on ISBN partial digits
- Edge deployment closer to Twilio region

---

## SECTION 11 — SECURITY AUDIT

| Area | Status | Severity | Fix |
|------|--------|----------|-----|
| Twilio webhook HMAC | ✅ Implemented | — | Keep enabled in prod |
| WS token | ✅ Optional HMAC | Low | Always on in prod |
| Shopify token | ✅ Env only | — | Never log |
| OpenAI key | ✅ Env only | — | — |
| Resend key | ✅ Env only | — | — |
| Admin endpoints | ⚠️ `INTERNAL_ADMIN_KEY` | Medium | IP allowlist + rotate key |
| Rate limits | ✅ Per-route | — | Tune for abuse |
| Prompt injection | ⚠️ Master prompt rules only | Medium | Red-team tests |
| Tool injection | ✅ Pydantic validation in `llm_tools.py` | Low | — |
| PII logging | ✅ Phone masking | Low | Audit all log lines |
| Payment safety | ✅ Strong gates | — | `payment/safety.py` |
| Order privacy | ✅ Verification gating | — | Tested |
| GDPR deletion | ❌ No API | High | Caller data deletion endpoint |
| API docs in prod | ✅ Disabled unless DEBUG | — | — |

---

## SECTION 12 — TESTING AUDIT

| Metric | Value |
|--------|-------|
| Active tests | **489** |
| Pass rate | **100%** (local) |

### Covered well
- Payment safety, email capture FSM, order privacy, orchestrator parity (`test_step4_orchestrator_parity.py`)
- Turn assembler, ISBN, output guardrails, facility unit tests (example data)
- Live log regressions (`test_v441`, `test_v443`, `test_v425`)

### Missing / weak
- End-to-end voice call with real Twilio sandbox
- Shopify sandbox integration (catalog, draft order, refund)
- Product-not-found → escalation email content assertion
- 51-facility CSV regression
- Load/soak tests
- Chaos: orchestrator failure without fallback
- Prompt injection adversarial suite

### Testing roadmap
1. **Week 1:** Escalation + not-found integration tests
2. **Week 2:** Shopify sandbox CI job (secrets in GitHub)
3. **Week 3:** Staging voice smoke on schedule
4. **Week 4:** Evaluation harness scoring naturalness + latency from recorded calls

---

## SECTION 13 — PRODUCTION READINESS AUDIT

| Area | Score | Notes |
|------|-------|-------|
| Env config | 70 | `validate_production()` checks core secrets |
| Redis enforcement | 85 | Fail-fast in prod |
| Postgres | 20 | Stub only |
| Deployment | 65 | PM2 + Nginx documented in `docs/DEPLOYMENT.md` |
| Health checks | 75 | `/health` with runtime identity |
| Monitoring | 40 | OTEL off |
| Alerting | 30 | Not codified |
| Backup/rollback | 50 | Git deploy; no blue/green |
| DR | 35 | Single-instance assumption |

**Production readiness score: 62/100**

---

## SECTION 14 — SCORECARD (strict)

| Category | Score | Rationale |
|----------|-------|-----------|
| Architecture | 72 | Clean orchestrator path; legacy debt remains |
| Agent design | 70 | Good tool surface; planner too shallow |
| Voice experience | 60 | CR + ElevenLabs capable; latency hurts |
| Latency | 58 | Multi-LLM + debounce |
| Tool reliability | 78 | Hardened Shopify tools + gates |
| Shopify commerce | 75 | Real API; search gaps for periodicals |
| Payment safety | 82 | Strong FSM + certifier |
| Email capture | 76 | Good FSM; ASR fragile |
| Memory | 55 | Redis-only durable path |
| Security | 74 | Good basics; no GDPR tooling |
| Observability | 48 | Logs only |
| Scalability | 52 | Single worker |
| Maintainability | 58 | Duplicate modules |
| Testing | 68 | Broad unit; thin E2E |
| Production readiness | 62 | Pilot OK, enterprise no |
| ElevenLabs-style readiness | 55 | Latency + monolithic turns |
| n8n-style readiness | 45 | No replay/branch UI |
| Enterprise readiness | 50 | Postgres, observability, facility data gaps |
| **Overall** | **66** | Honest mid-tier pilot |

---

## SECTION 15 — TOP 25 ACTION ITEMS

| Rank | Priority | Difficulty | Impact | Files | Recommendation |
|------|----------|------------|--------|-------|----------------|
| 1 | P0 | M | +10 | `facility/`, `scripts/ingest_facility_documents.py` | Ingest all 51 client CSV/PDF files |
| 2 | P0 | M | +9 | `planner_agent.py`, `shopify_tools.py` | Auto not-found → escalate with rich email |
| 3 | P0 | H | +8 | `postgres_store.py`, migrations | Real Postgres persistence |
| 4 | P0 | L | +7 | `response_composer.py` | Skip composer LLM when tools return `suggested_response` |
| 5 | P0 | L | +6 | `config.py` | Fail prod startup if SUPPORT_EMAIL unset |
| 6 | P1 | M | +7 | `planner_agent.py`, `multi_book_collector.py` | Multi-product planner steps |
| 7 | P1 | L | +5 | `README.md` | Fix orchestrator default documentation |
| 8 | P1 | M | +6 | `observability/` | Enable OTEL + Grafana/Datadog |
| 9 | P1 | H | +8 | `orchestrator/types.py`, postgres | Workflow event log per turn |
| 10 | P1 | M | +5 | `turn_assembler.py` | Debounce 350ms |
| 11 | P1 | L | +4 | `tests/` | Escalation email integration test |
| 12 | P1 | H | +6 | `ws/turn_dispatch.py` | Disable legacy fallback in prod |
| 13 | P2 | H | +5 | `archive_legacy/` | Remove dead active-tree modules |
| 14 | P2 | M | +4 | `shopify/graphql_queries.py` | Tax/discount fields |
| 15 | P2 | M | +5 | `call_memory_manager.py` | LLM rolling summary |
| 16 | P2 | L | +3 | `ecosystem.config.cjs` | Multi-worker guidance |
| 17 | P2 | M | +4 | `tool_router.py` | Tool retry with backoff |
| 18 | P2 | L | +3 | `prompt_pack/` | Archive duplicate prompts |
| 19 | P2 | M | +4 | CI | Shopify sandbox job |
| 20 | P2 | H | +5 | New module | GDPR caller deletion API |
| 21 | P3 | M | +3 | `supervisor_agent.py` | LLM planner for ambiguous intents only |
| 22 | P3 | L | +2 | `docs/DEPLOYMENT.md` | Blue/green runbook |
| 23 | P3 | M | +4 | `test_v4150_*` | Scheduled staging voice smoke |
| 24 | P3 | H | +5 | pgvector | Semantic facility search |
| 25 | P3 | M | +3 | `sync/webhooks.py` | Order update proactive context |

---

## SECTION 16 — FINAL RECOMMENDATION (Enterprise)

1. **Ready for real production?** **Pilot only** — single-tenant, monitored, with facility data and escalation gaps acknowledged.
2. **Premium voice AI feel?** **Not yet** — latency and turn monolith block ElevenLabs-class UX.
3. **Ready to scale?** **Not horizontally** without Postgres, observability, and multi-worker design.
4. **Must do next:** Ingest facility data; implement not-found escalation; enable tracing; implement Postgres turns.
5. **Do NOT change:** `llm_tools.py` tool contracts, payment safety gates, order privacy gating, Twilio WS auth.
6. **Delete later:** `workers/`, `pipeline/`, scouts, brain, prompt_pack (after import audit).
7. **Fastest path to 95+:** Items 1–10 above (~4–6 weeks focused engineering).
8. **Path to 100 enterprise:** Full workflow engine, evaluation loop, multi-region, compliance, 24/7 SRE runbooks.

---

# PART B — BUSINESS REQUIREMENT-FIT AUDIT

---

## REQUIREMENT 1 — PRODUCT SEARCH / SELLER FLOW

| Capability | Status | Evidence |
|------------|--------|----------|
| Search by ISBN | **Mostly complete** | `search_products` → barcode + cache (`shopify_tools.py:203-303`) |
| Search by title | **Mostly complete** | Shopify `SEARCH_PRODUCTS` + title cache |
| Search by author | **Partial** | Metafield `book.author` on ISBN path; title search only otherwise |
| Magazine name | **Partial** | Generic keyword search; no taxonomy routing in orchestrator planner |
| Newspaper name | **Partial** | Same |
| Multiple products per call | **Partial** | `multi_book_collector.py` exists; orchestrator planner only parallelizes 2 "compare" queries |
| Product not found handling | **Partial** | Returns `not_found`; ledger records ISBN; **no auto escalation workflow** |
| Alternatives | **Partial** | LLM may suggest; no dedicated recommendation tool in orchestrator path |
| Add multiple to cart | **Mostly complete** | `add_to_cart` + cart ledger |
| Confirm cart | **Mostly complete** | Payment FSM `payment_cart_confirmed` |
| Draft order + payment link | **Mostly complete** | `create_checkout`, `send_payment_link` |
| Email payment link | **Mostly complete** | Resend via `email_sender.py` |
| Not-found → email Jessica/support | **Missing** | `EscalateToCustomerService` exists but **not auto-triggered**; email lacks session ID, requested ISBN, customer email capture |

### Not-found escalation gap (detailed)

**Prompt says** (`agent_master_system_prompt.md:273-283`): escalate when book not listed.

**Code does:**
- `search_products` returns `not_found: true`
- `cart/candidate.py` records `isbn_not_found`
- `EscalateToCustomerService` → `escalate_to_human` → `_notify_support_escalation` **only if** `SUPPORT_EMAIL` + `RESEND_API_KEY` set
- Email body: caller masked, reason, summary — **no** session ID, phone, customer email, ISBN list

**Files:** `tools/shopify_tools.py`, `orchestrator/planner_agent.py`, `orchestrator/response_composer.py`, `agent_runtime/llm_tools.py`

**Recommended:** New planner branch on `not_found`; collect email; call `EscalateToCustomerService` with structured payload; customer script: *"I'll forward this to our team..."*

---

## REQUIREMENT 2 — ORDER LOOKUP

| Capability | Status |
|------------|--------|
| Real Shopify data | **Complete** |
| Order exists / status / fulfillment | **Complete** |
| Tracking | **Complete** (when present in Shopify) |
| Line items, qty, prices | **Complete** (verified) |
| Subtotal, shipping, total | **Complete** (verified) |
| Taxes/discounts | **Partial** — not all GraphQL fields exposed |
| Privacy gating | **Complete** — `verification_required` without email/phone |
| Tests | **Mostly complete** — `test_v441_live_call_regressions.py`, `test_step4_orchestrator_parity.py` |

**GraphQL:** `LOOKUP_ORDERS`, `GET_ORDER_WITH_REFUNDS` in `shopify/graphql_queries.py`  
**Files:** `tools/shopify_tools.py:336-516`, `shopify/order_privacy.py`

---

## REQUIREMENT 3 — REFUND / CANCEL FLOW

| Capability | Status |
|------------|--------|
| Refund status from Shopify | **Mostly complete** — `get_refund_status` |
| Refund date, amount, items | **Complete** |
| Card last 4 only | **Complete** — `order_privacy.card_last4_from_transactions` |
| Cancel request | **Partial** — `cancel_order_request` tool; staff action required |
| Never invent refund | **Complete** — tool-gated + prompt rules |
| Tests | **Partial** — `test_order_refund.py`, facility/order tests |

**Files:** `shopify_tools.py:553-700`, `llm_tools.py`

---

## REQUIREMENT 4 — FACILITY CSV POLICY KNOWLEDGE

| Expectation | Status |
|-------------|--------|
| 51 CSV files loaded | **Missing** — 1 example row in `facility_guidelines.csv` / `.json` |
| Facility search | **Partial** — `guidelines_registry.py` works with data |
| Content restrictions | **Partial** — `restriction_worker.py`, `book_content_matcher.py` |
| Policy links | **Missing in prod data** — `facility_docs_index.json` count=0 |
| PDF ingest | **Infrastructure exists** — `scripts/ingest_facility_documents.py` not run on client data |
| Tests | **Weak** — example facility only (`test_v434_facility_documents.py`) |

**Storage:** `app/data/facility_guidelines.json`, `facility_approved_list.csv`, `facility_docs/`  
**Ideal architecture:** Ingest pipeline → JSON registry + optional pgvector chunks → `facility_policy_lookup` tool (exists) → order reconciliation (`order_reconciliation.py`)

---

## REQUIREMENT 5 — HUMAN-LIKE VOICE SELLER EXPERIENCE

| Capability | Status |
|------------|--------|
| Fast greeting | **Mostly complete** — TwiML welcome + `VOICE_WELCOME_GREETING` |
| Natural tone / short answers | **Partial** — composer LLM + 50-word limit |
| One question at a time | **Partial** — prompt rule; not enforced in code |
| Barge-in | **Mostly complete** — interrupt cancels task |
| Progress while tools run | **Partial** — 400ms threshold |
| No spoken URLs | **Complete** — `output_guardrails`, composer regex |
| Long call memory | **Partial** — 50 turns; shallow summary |
| Multi-intent same call | **Mostly complete** |

**Latency bottlenecks:** debounce 550ms, supervisor LLM, Shopify 2.5s timeout, composer LLM.

---

## REQUIREMENT 6 — N8N-STYLE WORKFLOW

| Capability | Status |
|------------|--------|
| Supervisor / planner / router / parallel exec | **Complete** |
| Retries | **Partial** — OpenAI only |
| Branching on tool results | **Missing** — e.g. not_found → escalate |
| Workflow replay | **Missing** |
| Event history | **Partial** — logs + postgres hook stub |
| Human handoff | **Partial** — email escalation only |

---

## SECTION 7 — REQUIREMENT-FIT SCORES

| Requirement | Score | Rationale |
|-------------|-------|-----------|
| Product search | 72 | Core search works; author/periodical weak |
| Shopify API usage | 78 | Real GraphQL, caching, privacy |
| Order lookup | 80 | Strong with verification |
| Refund/cancel | 70 | Refund good; cancel is escalate-only |
| Facility CSV policy | **25** | Example data only |
| Payment link flow | 82 | Certified path exists |
| Email capture | 76 | FSM solid |
| Escalation flow | **45** | Tool exists; not-found workflow incomplete |
| Voice quality | 62 | Config-dependent |
| Latency | 58 | Multi-stage |
| Memory | 55 | No durable DB |
| Security/privacy | 78 | Order gating strong |
| Observability | 48 | — |
| Workflow/orchestration | 68 | Good skeleton; no branching |
| ElevenLabs-style readiness | 55 | — |
| n8n-style readiness | 45 | — |
| **Overall requirement-fit** | **63 / 100** | Business blocked on facility + escalation |

---

## SECTION 8 — GAP MATRIX

| Requirement | Status | Current files | Missing pieces | Severity | Recommended fix |
|-------------|--------|---------------|----------------|----------|-----------------|
| ISBN search | Mostly complete | `shopify_tools.py`, `tools/isbn.py` | — | Low | — |
| Title/author search | Partial | `search_products`, cache | Author metafield on all paths | Medium | Enrich GraphQL product query |
| Magazine/newspaper | Partial | `catalog_taxonomy.py` | Planner routing | Medium | Intent keywords → catalog_search |
| Multi-product call | Partial | `multi_book_collector.py` | Orchestrator wiring | High | Planner multi-step |
| Not-found honest reply | Mostly complete | `response_composer.py` | Deterministic not_found line | Medium | Composer branch |
| Not-found escalation email | **Missing** | `EscalateToCustomerService` | Auto trigger + rich email | **Critical** | Planner + email template |
| Cart + payment | Mostly complete | `cart/`, `payment/` | — | Low | — |
| Order lookup | Mostly complete | `lookup_order` | Tax/discount | Low | GraphQL fields |
| Refund lookup | Mostly complete | `get_refund_status` | — | Low | — |
| Facility 51 CSVs | **Missing** | `facility/guidelines_registry.py` | Client data ingest | **Critical** | Run ingest pipeline |
| Policy links/PDFs | **Missing** | `document_index.py` | Empty index | **Critical** | Ingest PDFs |
| Voice naturalness | Partial | `response_composer.py` | Latency | High | Fast path |
| Workflow replay | **Missing** | — | Event store | High | Postgres |
| Returning caller memory | Partial | `caller/repository.py` | Postgres | Medium | Persist profiles |

---

## SECTION 9 — TOP IMPLEMENTATION PLAN

### Phase 1 — Critical fixes (Week 1–2)
- **Files:** `planner_agent.py`, `response_composer.py`, `shopify_tools.py`, `config.py`
- **Work:** Not-found → email capture → `EscalateToCustomerService` with full payload; prod env validation for SUPPORT_EMAIL
- **Tests:** `test_product_not_found_escalation.py`
- **Score:** +8 → ~71

### Phase 2 — Product not-found escalation to Jessica (Week 2)
- **Files:** `tools/email_sender.py`, new `tools/escalation_templates.py`
- **Work:** Jessica/CUSTOMER_SERVICE_EMAIL routing; include call_sid, phone, email, ISBN/title, notes
- **Tests:** Resend mock assertion
- **Score:** +5 → ~76

### Phase 3 — Order/refund detail expansion (Week 3)
- **Files:** `graphql_queries.py`, `shopify_tools.py`
- **Work:** Taxes, discounts, multiple fulfillments
- **Tests:** Extend `test_order_refund.py`
- **Score:** +3 → ~79

### Phase 4 — Facility CSV policy agent (Week 3–5)
- **Files:** `scripts/ingest_facility_documents.py`, `data/facility_*`, `facility/guidelines_registry.py`
- **Work:** Ingest 51 CSVs; validate facility count; PDF excerpts
- **Tests:** Per-state facility lookup fixtures
- **Score:** +15 → ~85 (largest business unlock)

### Phase 5 — Voice latency and naturalness (Week 4–6)
- **Files:** `turn_assembler.py`, `response_composer.py`, `supervisor_agent.py`
- **Work:** Deterministic fast path; debounce tune; progress tokens
- **Tests:** Latency budget tests
- **Score:** +7 → ~88 voice

### Phase 6 — Workflow replay / n8n-style (Week 6–8)
- **Files:** `postgres_store.py`, new `workflow/event_store.py`
- **Work:** Persist PlannerResult + tool results; replay CLI
- **Score:** +5 → ~90

### Phase 7 — Enterprise monitoring (Week 8–10)
- **Files:** `observability/`, CI, `docs/DEPLOYMENT.md`
- **Work:** OTEL, dashboards, alerting, staging smoke cron
- **Score:** +5 → ~93

---

## APPENDIX — KEY FILE INDEX

| Purpose | Path |
|---------|------|
| App entry | `services/twilio-voice-agent/app/main.py` |
| Live dispatch | `app/ws/turn_dispatch.py` |
| Orchestrator | `app/orchestrator/runtime.py` |
| Tools | `app/agent_runtime/llm_tools.py`, `app/tools/shopify_tools.py` |
| Master prompt | `app/data/agent_master_system_prompt.md` |
| Config | `app/config.py` |
| Tests | `app/tests/` (489 tests) |
| Facility data | `app/data/facility_guidelines.json` (1 example facility) |
| Archive | `archive_legacy/2026_06_26_architecture_cleanup/` |
| Deploy | `ecosystem.config.cjs`, `docs/DEPLOYMENT.md` |

---

*End of audit. No code was modified during this analysis.*
