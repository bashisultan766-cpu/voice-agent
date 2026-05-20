# Solutions Architect Review
## Multi-Tenant Shopify Voice Agent SaaS

**Document Version:** 1.0  
**Date:** March 6, 2025  
**Role:** Senior Solutions Architect (Client Review)

**Scope:** Multi-tenant admin dashboard, Shopify-connected voice agents, Twilio routing, OpenAI voice logic, store-specific prompts, order/inventory/store-hours support, transcript logging and analytics.

---

## 1. Architecture Risks

| Risk | Description | Severity |
|------|-------------|----------|
| **Tight coupling of voice path to admin stack** | Voice orchestration, LLM, and Twilio handling in the same process as admin API can cause voice latency or failures when admin load spikes (e.g. bulk config updates, reporting). | High |
| **Single-region dependency** | Twilio webhooks, OpenAI, and app all in one region. Regional outage or latency spike affects all tenants and all live calls. | Medium |
| **No clear boundary for “agent config”** | Prompt version, knowledge docs, tools-enabled, and store context are separate entities. Inconsistent or partial load (e.g. cache miss on one piece) can make an agent behave inconsistently mid-call. | Medium |
| **Database as single point of failure for routing** | Resolving phone → agent and loading agent config from DB on every call. DB latency or brief unavailability causes failed or delayed call answer. | High |
| **Implicit ordering and eventual consistency** | Cache invalidation after config change is best-effort. A call could start with stale config if cache TTL hasn’t expired or invalidation fails. | Medium |
| **Monolith scaling** | Single deployable for admin + voice means you scale both together; cannot scale voice tier independently for call spikes. | Medium |
| **Vendor lock-in** | Deep use of Twilio (voice + possibly STT/TTS) and OpenAI. Switching provider requires non-trivial refactor of pipeline and config. | Low–Medium |

---

## 2. Security Risks

| Risk | Description | Severity |
|------|-------------|----------|
| **Tenant isolation bypass** | If any API or voice path uses tenant/store/agent IDs from the request (e.g. query param, body, or inferred from phone only without re-validation), one tenant could access another’s data or route calls to wrong agent. | Critical |
| **Credential handling** | Storing Shopify tokens and Twilio/OpenAI secrets. If refs are logged, or decrypted tokens live in memory/logs, compromise spreads across tenants. | Critical |
| **Injection in prompts or knowledge** | User-controlled system prompt, personality, or FAQ content passed to LLM without sanitization could lead to prompt injection, jailbreak, or exfiltration of other tenants’ data if context is shared. | High |
| **Webhook forgery** | Twilio webhooks without signature verification allow attackers to trigger fake call events, consume capacity, or corrupt session state. | High |
| **PII in logs and analytics** | Caller number, transcript, order details logged or sent to analytics. Unrestricted access or retention creates compliance and breach risk. | High |
| **Admin session and RBAC** | Weak session timeout, no MFA, or missing role checks on destructive actions (delete agent, change phone mapping) increase insider and account-compromise risk. | Medium |
| **OpenAI data usage** | By default OpenAI may use content for training. Customer/order/transcript data sent to OpenAI could violate data policies if not opted out or covered by DPA. | Medium |

---

## 3. Scale Risks

| Risk | Description | Severity |
|------|-------------|----------|
| **OpenAI rate limits** | Burst of concurrent calls hits OpenAI TPM/RPM limits; calls queue or fail. No per-tenant or per-agent limiting. | High |
| **Shopify API rate limits** | Tool calls (orders, inventory) per store hit Shopify bucket limits; agent returns errors or timeouts during peak. | High |
| **Twilio concurrency** | Account-level concurrent call limits. New tenants or traffic spike can hit cap; new calls fail. | Medium |
| **DB connection pool** | Each call may open DB connections for config and logging. Under load, pool exhaustion slows or fails both admin and voice. | High |
| **Redis as single cache** | Agent config and session state in one Redis. No partitioning; Redis latency or memory limits affect all tenants. | Medium |
| **Transcript and tool payload size** | Long conversations and large tool outputs grow context size; higher latency, cost, and risk of exceeding model context window. | Medium |
| **Analytics query load** | Heavy “call history” or reporting queries (full table scans, no limits) run on same DB as transactional workload. | Medium |

---

## 4. Data Privacy Risks

| Risk | Description | Severity |
|------|-------------|----------|
| **Voice and transcript retention** | Storing full transcripts and optional recordings. Unbounded retention or unclear policy conflicts with GDPR/CCPA and tenant expectations. | High |
| **Cross-border data** | Tenant and call data in one region; OpenAI/Twilio may process in other regions. Data residency and transfer restrictions may apply. | High |
| **PII in tool payloads** | Order IDs, customer names, phone numbers in tool input/output and logs. Exposed in logs, support tools, or analytics. | High |
| **Knowledge document content** | FAQs and policies may contain personal or business-sensitive data. Stored and sent to OpenAI; access control and retention must be defined. | Medium |
| **Audit log sensitivity** | Audit logs with IP, user agent, resource IDs. Treated as operational data only; may be PII and subject to access/deletion requests. | Medium |
| **No explicit consent for AI processing** | Callers not informed that conversation is processed by AI and sent to third parties (OpenAI). Required in some jurisdictions. | Medium |

---

## 5. Operational Risks

| Risk | Description | Severity |
|------|-------------|----------|
| **No circuit breaker for external APIs** | Repeated failures to OpenAI or Shopify keep retrying; cascading latency and timeouts for all callers. | High |
| **Insufficient observability** | Cannot correlate a specific call to agent config version, tool runs, and errors. Hard to debug “agent said wrong thing” or “call dropped.” | High |
| **Secret rotation** | Rotating Twilio/Shopify/OpenAI keys without a safe procedure can break all calls or admin until config is updated. | Medium |
| **Deployment during live calls** | Restart or deploy during active calls; in-process session state lost; callers hear drop or silence. | Medium |
| **No runbook for provider outages** | Twilio or OpenAI outage; team does not know how to fail gracefully (message, status page, escalation). | Medium |
| **Backup and restore** | DB backup/restore tested; but recovery of credentials (vault) and consistency with external state (Twilio numbers) not validated. | Low–Medium |

---

## 6. Failure Scenarios During Live Phone Calls

| Scenario | What happens | User impact |
|----------|----------------|-------------|
| **DB timeout when resolving agent** | Incoming webhook can’t get agent by phone number in time. Twilio may timeout; call not answered or generic message. | Call not answered or poor first impression. |
| **OpenAI timeout or 5xx** | LLM call hangs or fails. No fallback response. Caller hears silence or error. | Caller thinks line is dead or system broken. |
| **Shopify tool timeout** | “Where is my order?” tool blocks for 10+ seconds. TTS delayed; caller waits in silence. | Poor UX; caller may hang up. |
| **Cache returns stale config** | After admin changes prompt, cache still serves old version. Agent says outdated info (e.g. wrong hours). | Wrong information given to customer. |
| **Wrong agent (routing bug)** | Phone → agent mapping wrong or overwritten. Caller reaches agent for different store. | Wrong store context; data confusion; possible data leak. |
| **Session state lost (restart/crash)** | Process restarts mid-call. Redis or in-memory session gone. Next Twilio event has no context. | Call breaks; duplicate or incoherent behavior. |
| **Token exhaustion / context overflow** | Very long conversation or huge tool output. LLM errors or truncation. | Agent “forgets” earlier context or fails. |
| **Twilio webhook delivery failure** | Twilio retries; duplicate events or out-of-order (e.g. hangup before media). Session or transcript inconsistent. | Duplicate writes; confusing logs; possible duplicate charges. |
| **Credential invalid (rotated/revoked)** | Shopify token expired; tool calls fail. Agent can’t look up orders. | Agent says “I can’t access that right now.” |
| **Rate limit (OpenAI/Shopify)** | Too many concurrent calls or tool calls. Requests throttled. | Delays, timeouts, or generic “try again” for many callers. |

---

## 7. Recommended Mitigations

### Architecture

- **Decouple voice from admin:** Run voice orchestration (and optionally agent runtime) in a separate service or pool. Scale voice tier independently; admin load doesn’t slow calls.
- **Cache phone → agent and agent config:** Use Redis (or similar) with short TTL (e.g. 1–5 min). On cache miss, read from DB. Reduces DB dependency for hot path.
- **Atomic config snapshot:** On call start, load one “agent config bundle” (prompt version + knowledge refs + tools + store context) and use it for the whole call. Version it (e.g. config_version_id) so analytics can tie behavior to a specific config.
- **Plan for multi-region later:** Keep Twilio webhook URL and voice service deployable in another region; document failover and data residency constraints.

### Security

- **Strict tenant isolation:** Resolve tenant only from verified auth (JWT/session). For webhooks, resolve tenant only from phone → agent → tenant in DB. Never take tenant_id or agent_id from query/body for authorization.
- **Credentials:** Store only vault/secret refs in DB. Resolve at runtime in a dedicated service. Never log refs or decrypted secrets. Rotate with zero-downtime process (e.g. new secret, then switch ref).
- **Webhook verification:** Verify Twilio signature on every webhook; reject and log invalid requests.
- **Prompt/knowledge sanitization:** Validate/sanitize admin-entered prompt and FAQ content (length, encoding, block obvious injection patterns). Consider separate “sandbox” context for untrusted content.
- **Admin security:** Enforce session timeout, require MFA for production tenants, and require confirmation for destructive actions. RBAC so only allowed roles can change agents and phone mapping.
- **OpenAI:** Use API options that disable training on customer data; sign DPA where required. Document in privacy policy.

### Scale

- **Rate limiting:** Per-tenant (and optionally per-agent) limits for OpenAI and Shopify. Queue or return “high load, try again” when over limit.
- **Connection pooling:** Use a pool (e.g. PgBouncer) and limit connections per service. Voice path uses pool for config load and write; avoid long-held transactions during call.
- **Circuit breakers:** For OpenAI and Shopify, open circuit after N failures; return fallback response and stop calling until recovery. Prevents cascade.
- **Bounded context:** Cap transcript length (e.g. last N turns) and tool output size before sending to LLM. Truncate or summarize to avoid context overflow and cost.

### Data privacy

- **Retention policy:** Define and enforce retention for CallSession, Transcript, and any recordings (e.g. 90 days, then delete or anonymize). Document in DPA and privacy policy.
- **PII handling:** Mask or exclude PII from logs and non-essential analytics. Restrict access to raw transcripts and caller IDs to roles that need it; audit access.
- **Data residency:** Document where data is stored and processed (you, Twilio, OpenAI). Offer region choice or compliance mapping if required by enterprise tenants.
- **Consent and disclosure:** Where required, play a short notice that the call is handled by AI and may be processed by third parties; document in policy.

### Operations and live-call reliability

- **Observability:** One correlation ID (e.g. call_sid or internal call_id) from webhook through pipeline to DB and logs. Log config version, tool calls, and errors with that ID. Metrics: answer rate, latency p95, tool success rate by agent/store.
- **Graceful degradation:** On LLM failure or timeout, play a recorded or synthetic fallback (“I’m having trouble; please try again or call back later”). On Shopify failure, agent says it can’t look up that info right now.
- **Stateless voice workers:** Where possible, keep call state in Redis (or Twilio) so that restarting workers doesn’t kill active calls. Design so one webhook can be retried safely (idempotent where possible).
- **Runbooks:** Document response to Twilio/OpenAI/Shopify outage: status page, fallback message, when to escalate. Test fallback path periodically.
- **Safe deployment:** Deploy with rolling or blue/green; drain in-flight calls before killing old instances if session state is in-process. Prefer external session state (e.g. Redis) so new instance can continue the call.

### MVP-specific

- **Single tenant for MVP:** Reduces tenant-isolation and multi-tenant config bugs; focus on one production tenant first.
- **Fewer external dependencies in critical path:** Cache agent config aggressively; optional: preload/store minimal Shopify data (e.g. hours) in DB to avoid Shopify call on every “store hours” question.
- **Explicit fallback message:** One clear “system is busy or unavailable” message used everywhere for timeouts and provider errors.

---

## 8. What to Simplify in MVP

| Area | Simplify for MVP | Rationale |
|------|-------------------|-----------|
| **Tenancy** | Single tenant only. | Removes cross-tenant bugs and simplifies auth and data model; add multi-tenant after product is stable. |
| **Voice deployment** | Same process as admin is OK. | Fewer moving parts; accept that under heavy admin load voice may be slower. Add separate voice service when scaling. |
| **Config loading** | Load from DB with short Redis cache (e.g. 5 min). Skip “atomic config version” snapshot initially. | Simpler; accept small risk of config change mid-call. Add versioning when you need reproducibility. |
| **Tools** | Start with 2–3 tools (e.g. store hours, order status, simple product lookup). | Reduces Shopify rate and complexity; add inventory, policies, branches later. |
| **Knowledge** | Simple FAQ list only (no RAG, no vector store). Inject as text in system message. | Cuts scope and failure modes; good enough for MVP. |
| **Analytics** | List of call sessions + basic counts (total calls, duration). No dashboards or aggregates. | Enough for “did it work?” and support; defer charts and exports. |
| **Transcript storage** | Store transcript per call; no search or replay UI. | Compliance and debugging; avoid building search/indexing in MVP. |
| **Regions** | Single region. | Simpler ops and compliance; document limitation. |
| **Rate limiting** | Global or per-tenant limit on concurrent calls only. | Prevents runaway load; defer per-agent or per-tool limits. |
| **Fallback** | Single static or TTS fallback message for all failures. | One path to test and maintain. |
| **Auth** | Single role (admin). No RBAC. | Faster to ship; add roles when multiple users per tenant. |
| **Audit** | Write audit log for key actions; no audit log API or UI. | Supports compliance and debugging later; no UI to build in MVP. |
| **Secrets** | Env vars for Twilio/OpenAI; one Shopify token per store in DB (encrypted). No vault. | Fewer components; migrate to vault when you have more tenants or compliance needs. |

**MVP principle:** Ship a single-tenant, single-region flow that answers calls correctly with a small set of tools and a clear fallback. Add multi-tenant, scale-out, rich analytics, and stricter resilience in the next phase.

---

## Summary Table

| Category | Top risks | Key mitigation |
|----------|-----------|-----------------|
| **Architecture** | DB on hot path; monolith | Cache routing + config; optional separate voice service later |
| **Security** | Tenant isolation; credentials; injection | Tenant from auth only; refs only in DB; verify webhooks; sanitize prompts |
| **Scale** | OpenAI/Shopify limits; pool exhaustion | Per-tenant limits; circuit breakers; connection pooling; bounded context |
| **Privacy** | Retention; PII in logs; cross-border | Retention policy; mask PII; document residency and consent |
| **Operations** | No circuit breaker; poor observability | Fallback path; correlation ID; metrics; runbooks |
| **Live calls** | Timeouts; stale config; wrong agent | Cache + TTL; atomic config; fallback message; verify routing |
| **MVP** | Scope creep | Single tenant; minimal tools; list-only analytics; env-based secrets; one fallback |

---

*End of review.*
