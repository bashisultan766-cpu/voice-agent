# Technical Architecture
## Multi-Tenant AI Voice Agent Platform for Shopify

**Document Version:** 1.0  
**Date:** March 6, 2025  
**Role:** Principal Software Architect

---

## 1. System Context Diagram

```
                                    ┌─────────────────────────────────────────────────────────────────┐
                                    │                     EXTERNAL ACTORS                             │
                                    └─────────────────────────────────────────────────────────────────┘
                                                              │
     ┌──────────────┐         HTTPS                    ┌──────▼──────┐         PSTN / SIP       ┌──────────────┐
     │ Tenant Admin │ ◄──────────────────────────────► │   Admin     │                           │   Customer   │
     │  (Browser)   │                                  │  Dashboard  │                           │   (Phone)    │
     └──────────────┘                                  └──────┬──────┘                           └──────┬──────┘
                                                              │                                                │
                                    ┌─────────────────────────┼────────────────────────────────────────────┐  │
                                    │                         │         PLATFORM BOUNDARY                    │  │
                                    │                         ▼                                                │  │
                                    │  ┌──────────────────────────────────────────────────────────────┐   │  │
                                    │  │                    API Gateway / Ingress                      │   │  │
                                    │  │              (Auth, routing, rate limit)                       │   │  │
                                    │  └───────┬────────────────────────────────────┬─────────────────┘   │  │
                                    │          │                                    │                      │  │
                                    │          ▼                                    ▼                      │  │
                                    │  ┌───────────────────┐              ┌─────────────────────────┐    │  │
                                    │  │  Admin Backend    │              │   Voice Orchestrator    │    │  │
                                    │  │  (REST/GraphQL)   │              │   (Call handler,        │◄───┼──┘
                                    │  │  - Stores CRUD    │              │    agent resolution,     │    │
                                    │  │  - Agents CRUD    │              │    session state)        │    │
                                    │  │  - Config, FAQs   │              └───────────┬─────────────┘    │
                                    │  │  - Phone mapping  │                          │                  │
                                    │  └─────────┬─────────┘                          │                  │
                                    │            │                                    │                  │
                                    │            │         ┌──────────────────────────┼──────────────┐   │
                                    │            │         │                          ▼              │   │
                                    │            │         │  ┌─────────────────────────────────────┐│   │
                                    │            ▼         │  │      Agent Runtime (per call)       ││   │
                                    │  ┌───────────────────┴──┴─┐  - Load agent config (DB/cache)  ││   │
                                    │  │     PostgreSQL         │  - LLM (OpenAI) + tools           ││   │
                                    │  │  - Tenants, Stores,    │  - STT/TTS (OpenAI / Twilio)      ││   │
                                    │  │    Agents, Config,     │  - Tool execution (Shopify, etc.) ││   │
                                    │  │    FAQs, Phone map     │  └────────────────────────────────┘│   │
                                    │  └───────────────────────┘                                    │   │
                                    │            │                                                    │   │
                                    │            │         ┌─────────────────────────────────────────┘   │
                                    │            │         │  Redis (cache, queue, session)                │
                                    │            │         └─────────────────────────────────────────────┤
                                    │            │                                                         │
                                    │  ┌─────────▼─────────────────────────────────────────────────────────▼─┐
                                    │  │              Background Workers (optional)                           │
                                    │  │  - Shopify sync (products, orders, store config)                    │
                                    │  │  - Cache invalidation, cleanup                                      │
                                    │  └────────────────────────────────────────────────────────────────────┘
                                    └──────────────────────────────────────────────────────────────────────────┘
                                                              │
                                    ┌─────────────────────────┼───────────────────────────────────────────────┐
                                    │                         ▼              EXTERNAL SYSTEMS                  │
                                    │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
                                    │  │   Twilio    │  │   OpenAI    │  │  Shopify    │  │  (Auth IdP)      │ │
                                    │  │  - Voice    │  │  - Chat     │  │  - Admin    │  │  e.g. Auth0,     │ │
                                    │  │  - STT/TTS  │  │  - STT/TTS  │  │  - Storefront│  │  Okta, custom   │ │
                                    │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘ │
                                    └─────────────────────────────────────────────────────────────────────────┘
```

**Legend:**
- **Admin Dashboard** = SPA or SSR app consumed by Tenant Admins.
- **Admin Backend** = APIs for stores, agents, config, phone mapping; enforces tenant isolation.
- **Voice Orchestrator** = Accepts Twilio webhooks, resolves agent by phone number, manages call state.
- **Agent Runtime** = Per-call logic: load config, run LLM, run tools, drive STT/TTS.
- **PostgreSQL** = Source of truth for tenants, stores, agents, config, FAQs, phone mapping.
- **Redis** = Agent config cache, job queue, optional call session state.
- **External:** Twilio (telephony + optional STT/TTS), OpenAI (LLM + optional STT/TTS), Shopify (store data), IdP (admin auth).

---

## 2. Main Services

| Service | Responsibility | Key interfaces |
|--------|----------------|----------------|
| **Admin API** | Tenant/store/agent CRUD, config (prompt, FAQs, tools), phone mapping, authZ (tenant-scoped). Serves Admin Dashboard. | REST or GraphQL; session/JWT from IdP. |
| **Admin Dashboard** | Web UI for managing stores, agents, config, versions, phone numbers. | Calls Admin API; OAuth/OIDC login. |
| **Voice Orchestrator** | Receives Twilio voice webhooks (incoming call, digits, stream). Resolves agent by `To` number; creates/attaches call session; delegates to Agent Runtime. | HTTP webhooks (Twilio → our URL). |
| **Agent Runtime** | Per call: load agent config (DB + Redis cache), run conversation loop (STT → LLM + tools → TTS), call Shopify/tools. Stateless per request. | Invoked by Voice Orchestrator (in-process or internal HTTP). |
| **Shopify Sync Worker** (optional) | Periodic or webhook-driven sync: products, orders, store/branch info into platform DB or cache for low-latency tool use. | Reads Shopify API; writes to PostgreSQL/cache. |
| **Background Workers** | Cache invalidation on config change, cleanup, scheduled jobs. Optional for MVP. | Redis queue (e.g. Bull, Celery); triggered by Admin API or scheduler. |

**Service boundaries (recommendation):**
- **Monolith-friendly option:** Admin API + Voice Orchestrator + Agent Runtime in one deployable app (e.g. Node/Python), with clear internal modules. Simplifies deployment and local dev; scales by replicas + Redis/Postgres.
- **Split option:** Separate “Admin” service (API + dashboard backend) and “Voice” service (Orchestrator + Runtime). Scale voice tier independently under high call volume. Both share PostgreSQL and Redis.

---

## 3. Data Flow: Incoming Phone Call

```
  Customer        Twilio          Voice Orchestrator      Agent Runtime         OpenAI      Shopify    PostgreSQL   Redis
     │               │                      │                     │                │            │           │         │
     │  Call store   │                      │                     │                │            │           │         │
     │──────────────►│                      │                     │                │            │           │         │
     │               │  POST /voice/incoming (To, From, CallSid)   │                │            │           │         │
     │               │─────────────────────►│                     │                │            │           │         │
     │               │                      │  Resolve agent by    │                │            │           │         │
     │               │                      │  phone number        │                │            │         │         │
     │               │                      │──────────────────────┼────────────────┼───────────►│           │         │
     │               │                      │  (cache: phone→agent_id; else DB)     │            │           │         │
     │               │                      │◄─────────────────────┼────────────────┼───────────┤           │         │
     │               │                      │  Load agent config   │                │            │           │         │
     │               │                      │  (cache then DB)      │                │            │           │         │
     │               │                      │──────────────────────┼────────────────┼───────────┼──────────►│         │
     │               │                      │◄─────────────────────┼────────────────┼───────────┼───────────┤         │
     │               │                      │  Create session      │                │            │           │         │
     │               │                      │  (Redis: call_sid → agent_id, store_id, config_ref)            │         │
     │               │                      │─────────────────────────────────────────────────────────────────────────►│
     │               │                      │  Return TwiML (e.g. <Connect><Stream>) │            │           │         │
     │               │◄─────────────────────│                     │                │            │           │         │
     │               │  TwiML               │                     │                │            │           │         │
     │  ◄────────────│  (answer + stream)   │                     │                │            │           │         │
     │               │                      │                     │                │            │           │         │
     │               │  WebSocket/stream events (audio chunks, mark)                │            │           │         │
     │               │─────────────────────►│─────────────────────►│                │            │           │         │
     │               │                      │                     │  STT (audio→text)           │           │         │
     │               │                      │                     │────────────────►│            │           │         │
     │               │                      │                     │◄────────────────│            │           │         │
     │               │                      │                     │  LLM (prompt + tools)         │           │         │
     │               │                      │                     │────────────────►│            │           │         │
     │               │                      │                     │  Tool: get product/order      │           │         │
     │               │                      │                     │────────────────────────────────────────►│           │
     │               │                      │                     │◄─────────────────────────────────────────┤           │
     │               │                      │                     │◄────────────────│            │           │         │
     │               │                      │                     │  TTS (text→audio)            │           │         │
     │               │                      │                     │────────────────►│            │           │         │
     │               │                      │                     │◄────────────────│            │           │         │
     │               │  Stream audio out     │◄────────────────────│                │            │           │         │
     │               │◄─────────────────────│                     │                │            │           │         │
     │  ◄────────────│  (play to user)      │                     │                │            │           │         │
     │               │  ... loop until hangup ...                 │                │            │           │         │
     │  Hangup       │                      │                     │                │            │           │         │
     │──────────────►│  POST /voice/status (completed)             │                │            │           │         │
     │               │─────────────────────►│  Clean session Redis │                │            │           │         │
     │               │                      │─────────────────────────────────────────────────────────────────────────►│
```

**Design notes:**
- **Agent resolution:** Always by `To` number → `phone_number_mappings` → `agent_id`. Cache mapping in Redis (key e.g. `phone:{number}` → `agent_id`, TTL 5–15 min); invalidate on mapping change.
- **Config load:** Per call, load agent config (prompt, personality, FAQs, tool flags, store_id) from Redis cache; on miss, load from PostgreSQL and populate cache. All by `tenant_id` + `agent_id` to enforce isolation.
- **Session:** Store minimal call state in Redis (call_sid, agent_id, store_id, started_at) for the duration of the call; no PII beyond what’s needed for tools.
- **Streaming:** Twilio Media Streams (or similar) send audio to our endpoint; we run STT → LLM (+ tools) → TTS and stream audio back. OpenAI Realtime API or separate STT/TTS calls depending on product choice.

---

## 4. Data Flow: Agent Creation

```
  Tenant Admin     Admin Dashboard (SPA)    Admin API           PostgreSQL      Redis (optional)
       │                    │                    │                    │                │
       │  Create agent       │                    │                    │                │
       │  (store_id, name,   │                    │                    │                │
       │   prompt, tools…)   │                    │                    │                │
       │────────────────────►│                    │                    │                │
       │                     │  POST /stores/:id/agents  (JWT: tenant_id)               │
       │                     │───────────────────►│                    │                │
       │                     │                    │  Validate tenant   │                │
       │                     │                    │  owns store        │                │
       │                     │                    │───────────────────►│                │
       │                     │                    │◄───────────────────┤                │
       │                     │                    │  INSERT agent      │                │
       │                     │                    │  INSERT agent_config (version 1)    │
       │                     │                    │───────────────────►│                │
       │                     │                    │◄───────────────────┤                │
       │                     │                    │  (Optional) Invalidate cache        │
       │                     │                    │  for this store/agent               │
       │                     │                    │────────────────────────────────────►│
       │                     │◄───────────────────│  201 + agent payload               │
       │  ◄──────────────────│  Show success      │                    │                │
       │                     │                    │                    │                │
       │  Add phone number   │                    │                    │                │
       │  to agent           │                    │                    │                │
       │────────────────────►│  POST /agents/:id/phone-numbers          │                │
       │                     │───────────────────►│  INSERT phone_number_mappings       │
       │                     │                    │───────────────────►│                │
       │                     │                    │  Invalidate phone→agent cache        │
       │                     │                    │────────────────────────────────────►│
       │                     │◄───────────────────│  201                               │
```

**Design notes:**
- Every request is scoped by `tenant_id` from the auth token; store and agent IDs are validated to belong to that tenant.
- Agent and `agent_config` (or equivalent) are created in one transaction; first version is draft or active depending on product rules.
- Phone number mapping triggers cache invalidation so the next call resolves to the new agent.
- No direct Shopify call in this flow; Shopify credentials are stored at store level and used at runtime by the Agent Runtime when tools run.

---

## 5. Data Flow: Shopify Sync

Two patterns: **on-demand (at call time)** and **periodic/event-driven sync**. Architecture supports both.

### 5.1 On-demand (runtime only)

- No separate sync job. When a tool needs product/order/store data, the Agent Runtime calls Shopify APIs in real time using the store’s credentials.
- Pros: Always fresh. Cons: Latency and rate limits on every tool use.

### 5.2 Periodic / webhook-driven sync (recommended for scale)

```
  Shopify          Webhook / Cron         Sync Worker           PostgreSQL         Redis
     │                    │                     │                     │               │
     │  products/update   │  (or cron per store) │                     │               │
     │  orders/create     │─────────────────────►│                     │               │
     │                    │                     │  Load store credentials              │
     │                    │                     │─────────────────────►│               │
     │                    │                     │  Fetch from Shopify API              │
     │                    │                     │◄─────────────────────│               │
     │                    │                     │  UPSERT products_snapshot,          │
     │                    │                     │  orders_snapshot, store_hours        │
     │                    │                     │─────────────────────►│               │
     │                    │                     │  Invalidate store cache              │
     │                    │                     │─────────────────────────────────────►│
```

**Suggested sync targets:**
- **Store/branch context:** hours, addresses, policies (synced periodically or on admin save).
- **Products (books):** product list, title, price, availability; sync on schedule or Shopify webhooks.
- **Orders:** recent orders for “where is my order” type tools; sync recent N or by webhook.

**Data placement:**
- Store in PostgreSQL in tenant-scoped tables (e.g. `store_product_cache`, `store_order_cache`) with `store_id` and `tenant_id`. Agent Runtime tools read from DB (or from Redis cache backed by DB) to avoid calling Shopify on every utterance.
- Sync worker runs with tenant/store context; uses same credentials as stored for the store; rate-limits per store to respect Shopify limits.

---

## 6. Key Database Entities

Schema is **tenant-scoped** on all relevant tables. Below is a normalized, minimal set.

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│     tenants     │       │     stores       │       │     agents      │
├─────────────────┤       ├─────────────────┤       ├─────────────────┤
│ id (PK)         │───┐   │ id (PK)         │───┐   │ id (PK)         │
│ name            │   │   │ tenant_id (FK)   │◄──┘   │ store_id (FK)   │◄──┐
│ created_at      │   └──►│ shopify_domain  │       │ name            │   │
│ updated_at      │       │ shopify_token   │       │ description     │   │
└─────────────────┘       │ (encrypted)     │       │ enabled         │   │
                          │ ...             │       │ current_config_id(FK)│
                          └────────┬────────┘       │ created_at      │   │
                                   │                │ updated_at      │   │
                                   │                └────────┬────────┘   │
                                   │                         │            │
┌─────────────────┐       ┌────────▼────────┐       ┌────────▼────────┐   │
│ agent_configs   │       │ phone_number_   │       │ store_branches   │   │
├─────────────────┤       │ mappings       │       │ (optional)       │   │
│ id (PK)         │       ├────────────────┤       ├─────────────────┤   │
│ agent_id (FK)   │       │ id (PK)         │       │ id (PK)          │   │
│ version         │       │ agent_id (FK)   │       │ store_id (FK)    │◄──┘
│ system_prompt   │       │ phone_number    │       │ name, address    │
│ personality     │       │ (E.164, unique) │       │ hours_json       │
│ store_context   │       │ created_at      │       │ ...              │
│ tools_enabled   │       └─────────────────┘       └─────────────────┘   │
│ (JSONB array)   │                                                         │
│ is_active       │       ┌─────────────────┐       ┌─────────────────┐   │
│ created_at      │       │ agent_faqs      │       │ sync/snapshots   │   │
└─────────────────┘       ├─────────────────┤       │ (if sync used)   │   │
                          │ id (PK)         │       ├─────────────────┤   │
                          │ agent_config_id │       │ store_id,        │   │
                          │ question        │       │ products_json,   │   │
                          │ answer          │       │ orders_json,     │   │
                          │ sort_order      │       │ synced_at        │   │
                          └─────────────────┘       └─────────────────┘   │
```

**Entity summary:**

| Entity | Purpose |
|--------|--------|
| **tenants** | Top-level isolation; one row per customer (org). |
| **stores** | One per Shopify store; `tenant_id`; holds `shopify_domain`, encrypted `shopify_token` (or OAuth refresh token). |
| **agents** | One per voice agent; `store_id`; `enabled`; `current_config_id` → active agent_config. |
| **agent_configs** | Versioned config per agent: `system_prompt`, `personality`, `store_context`, `tools_enabled` (JSONB), `is_active`. |
| **agent_faqs** | Q&A pairs; linked to `agent_config_id` (or agent_id if you don’t version FAQs separately). |
| **phone_number_mappings** | E.164 `phone_number` → `agent_id`; unique on `phone_number` globally so one number maps to one agent. |
| **store_branches** | Optional; branch-specific hours, address, name for “branch” tools. |
| **Sync/snapshots** | If using sync: e.g. `store_product_cache`, `store_order_cache` with `store_id`, `tenant_id`, synced payload and `synced_at`. |

**Indexes (critical for isolation and lookups):**
- All tenant-scoped tables: `(tenant_id, id)` and queries always filter by `tenant_id`.
- `phone_number_mappings(phone_number)` unique for fast agent resolution.
- `agent_configs(agent_id, is_active)` for resolving active config.
- `stores(tenant_id)`, `agents(store_id)`.

---

## 7. Security Boundaries

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    TRUST BOUNDARIES                                         │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐   │
│  │  BOUNDARY 1: Internet → Platform                                                     │   │
│  │  - TLS only (HTTPS).                                                                 │   │
│  │  - Admin: Auth via IdP (OAuth2/OIDC); JWT or session with tenant_id.                 │   │
│  │  - Voice: Twilio webhook signature verification; validate request from Twilio.       │   │
│  │  - Rate limiting per IP / per tenant at gateway.                                    │   │
│  └─────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐   │
│  │  BOUNDARY 2: Application → Data                                                      │   │
│  │  - All DB queries scoped by tenant_id (and store_id where applicable).               │   │
│  │  - No raw SQL building tenant_id from user input; use from token/session only.        │   │
│  │  - Redis keys namespaced: tenant_id in key or use tenant-scoped key prefix.           │   │
│  │  - Shopify tokens encrypted at rest (e.g. application-level or DB encryption).      │   │
│  └─────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐   │
│  │  BOUNDARY 3: Platform → External                                                     │   │
│  │  - Twilio: outbound requests with AuthToken in header; use env secrets.              │   │
│  │  - OpenAI: API key in header; use env secrets; optional tenant-level key later.      │   │
│  │  - Shopify: per-store token from DB (decrypted in app); never log.                   │   │
│  │  - IdP: client secret in env; redirect URIs allowlisted.                             │   │
│  └─────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                             │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Enforcement summary:**

| Boundary | Control |
|----------|--------|
| **Admin API** | Every endpoint resolves `tenant_id` from JWT/session; all reads/writes filter by `tenant_id`; store/agent IDs checked to belong to tenant. |
| **Voice** | Incoming webhook verified with Twilio signature; agent resolved from phone number only; config loaded by agent_id (already tenant-scoped in DB). No tenant in request; isolation via phone → agent → tenant. |
| **Secrets** | Twilio/OpenAI/IdP secrets in env or secret manager; Shopify tokens in DB encrypted; never in logs or frontend. |
| **Network** | Admin and voice endpoints behind same ingress with TLS; optional: put voice in a separate subdomain/path and restrict to Twilio IPs. |

---

## 8. Recommended Deployment Architecture

Target: single region, 7→100+ stores; high availability for voice and admin.

```
                         ┌─────────────────────────────────────────────────────────────┐
                         │                    Load Balancer (HTTPS)                     │
                         └───────────────────────────┬─────────────────────────────────┘
                                                      │
                    ┌─────────────────────────────────┼─────────────────────────────────┐
                    │                                 │                                 │
                    ▼                                 ▼                                 ▼
            ┌───────────────┐                 ┌───────────────┐                 ┌───────────────┐
            │  App Server   │                 │  App Server   │                 │  App Server   │
            │  (Admin +     │                 │  (Admin +     │                 │  (Voice       │
            │   Voice)      │                 │   Voice)      │                 │   optional)   │
            └───────┬───────┘                 └───────┬───────┘                 └───────┬───────┘
                    │                                 │                                 │
                    └─────────────────────────────────┼─────────────────────────────────┘
                                                      │
         ┌────────────────────────────────────────────┼────────────────────────────────────────────┐
         │                                            │              Managed services               │
         │  ┌─────────────────┐      ┌────────────────▼────────────────┐      ┌─────────────────┐ │
         │  │   PostgreSQL    │      │            Redis                 │      │  Object Store   │ │
         │  │   (Primary +    │      │  (Cache + Queue, optional         │      │  (optional:     │ │
         │  │    Replica(s))  │      │   cluster or single node)        │      │   recordings)   │ │
         │  └─────────────────┘      └─────────────────────────────────┘      └─────────────────┘ │
         └────────────────────────────────────────────────────────────────────────────────────────┘
```

**Recommendations:**

| Component | Recommendation |
|-----------|----------------|
| **Compute** | 2+ app replicas (e.g. containers or VMs) behind a load balancer; stateless so replicas can run both Admin and Voice. |
| **PostgreSQL** | Managed (e.g. RDS, Cloud SQL, Supabase) with primary + at least one read replica; use replica for read-heavy reporting if needed. |
| **Redis** | Managed (e.g. ElastiCache, Memorystore) single node for MVP; cluster when you need more throughput or HA. |
| **Secrets** | From env or secret manager (e.g. AWS Secrets Manager, Vault); injected at deploy time. |
| **Scaling** | Horizontal: add app replicas; scale Redis/Postgres per provider guidance. Voice can be separated later into its own service and scaled independently. |
| **Region** | Single region for MVP; replicate DB and add a second region when you need DR or lower latency in multiple geos. |

---

## 9. Failure Points and Mitigation

| Failure point | Impact | Mitigation |
|---------------|--------|------------|
| **Twilio outage** | New/active calls fail or degrade. | Use Twilio status page and SLA; design TwiML so that on our timeout we play a “try again later” message; consider multi-provider later. |
| **OpenAI outage or high latency** | Agent slow or unable to respond. | Timeouts on LLM calls (e.g. 10–15 s); fallback message (“I’m having trouble right now”); optional fallback model or provider in config. |
| **PostgreSQL unavailable** | Cannot load agent config; admin cannot save. | Managed DB with HA (primary + replica, automatic failover); connection pooling (e.g. PgBouncer); retries with backoff in app. |
| **Redis unavailable** | Cache miss; every call hits DB. Agent creation cache invalidation may fail. | Treat Redis as cache: on failure, read from DB only; optional in-memory short TTL cache per process; queue jobs can retry or fallback to DB. |
| **Shopify API rate limit / down** | Tool calls fail; agent gives “I can’t look that up right now.” | Per-store rate limiting and exponential backoff; sync reduces real-time Shopify calls; cache product/order data when using sync. |
| **Agent config stale in cache** | Admin updates config but call uses old config. | On config/phone mapping update, invalidate Redis keys for that agent/phone; short TTL (e.g. 5–15 min) as safety net. |
| **Voice Orchestrator overload** | Dropped calls or long queue. | Scale app replicas; use async processing for non–real-time work; ensure Twilio concurrency and timeouts are tuned. |
| **Tenant data leak** | Data from one tenant returned to another. | Enforce tenant_id on every query; code review and tests for tenant isolation; no tenant_id from client, only from auth. |
| **Secrets leakage** | Compromise of Twilio/OpenAI/Shopify. | Secrets in secret manager; rotate periodically; audit access; no secrets in logs or frontend. |

---

## 10. Recommended Tech Stack and Rationale

| Layer | Recommendation | Rationale |
|-------|----------------|-----------|
| **Admin dashboard** | React or Next.js (or Vue/Nuxt) + TypeScript | Component model and ecosystem; Next.js gives SSR/API routes if you want a single repo. |
| **Admin API** | Node.js (Express/Fastify) or Python (FastAPI) | Good fit for JSON APIs, Twilio/OpenAI SDKs, and fast iteration; align with team strength. |
| **Voice Orchestrator + Agent Runtime** | Same runtime as Admin API (Node or Python) | Reuse auth patterns, DB client, and config loading; single codebase and deploy; can split into separate service later. |
| **PostgreSQL** | 15+ with JSONB | Strong consistency, JSONB for flexible config/tools_enabled; mature tooling and managed offerings. |
| **Redis** | 7+ | Caching and optional queues (Bull/BullMQ or Celery); simple and widely supported. |
| **Twilio** | Voice + Media Streams (or equivalent) | Meets “Twilio for phone calls”; Media Streams for streaming audio to our backend. |
| **OpenAI** | Chat Completions + optional Whisper + TTS | Meets “OpenAI for AI”; single vendor for LLM and optional STT/TTS; Realtime API is an alternative for lower latency. |
| **Auth** | OAuth2/OIDC (Auth0, Okta, or Cognito) | Offload MFA and user management; JWT with `tenant_id` (or sub → tenant lookup) for API authZ. |
| **Hosting** | AWS, GCP, or Azure | Use managed Postgres, Redis, LB, and secrets; same for any cloud. |
| **Containers** | Docker + Kubernetes or ECS/Cloud Run | Reproducible builds; scale replicas; same image for admin and voice. |
| **CI/CD** | GitHub Actions or GitLab CI | Build, test, deploy on merge; run tenant-isolation and integration tests. |
| **Observability** | Logs + metrics (e.g. CloudWatch, Datadog) | Structured logs with tenant_id; metrics for call count, errors, latency; alerts on critical failures. |

**Why this stack:**
- **Single language/runtime** (e.g. Node or Python) for API + Voice reduces context switching and simplifies deployment.
- **PostgreSQL + Redis** matches your constraints and supports tenant isolation and caching.
- **Twilio + OpenAI** match stated choices; keep voice and LLM behind clear interfaces so you can swap later if needed.
- **Managed DB and Redis** reduce ops and give you room to grow from 7 to 100+ stores without a rewrite.

---

## Appendix: Document History

| Version | Date       | Author | Changes        |
|---------|------------|--------|----------------|
| 1.0     | 2025-03-06 | —      | Initial draft. |

*End of document.*
