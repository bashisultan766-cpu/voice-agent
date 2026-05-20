# Technical Product Requirements Document  
## Multi-Tenant AI Voice Agent Platform for Shopify

**Document Version:** 1.0  
**Date:** March 6, 2025  
**Classification:** Client-Ready Technical PRD

---

## 1. Product Overview

### 1.1 Purpose

This document defines the technical and product requirements for a **production-ready, multi-tenant SaaS platform** that enables a single client (tenant) to manage **multiple AI voice agents** across **multiple Shopify stores**. Each voice agent answers inbound customer phone calls with store-specific context, personality, and capabilities.

### 1.2 Problem Statement

- The client owns **7 Shopify stores today**, with more expected.
- Each store needs **one or more** dedicated voice agents to handle customer calls.
- Agents must be **individually configurable** (prompts, personality, tools, FAQs, store context, phone numbers).
- There is no single place to **create, version, enable/disable, and operate** these agents at scale.

### 1.3 Solution Summary

A centralized **admin dashboard** and **backend platform** that:

- **Tenant:** Represents the client (owner of multiple stores).
- **Store:** Represents a Shopify store; belongs to one tenant.
- **Agent:** Represents an AI voice agent; belongs to one store; has its own config, prompt, tools, FAQs, and phone number mapping.
- **Voice runtime:** Handles inbound calls, runs the configured agent (LLM + TTS/STT), and executes tools (e.g., inventory, orders, store hours).

Outcomes:

- One place to manage all stores and agents.
- Per-agent control over personality, knowledge, and behavior.
- Clear mapping of phone numbers → agents.
- Versioning and lifecycle control (create, edit, delete, enable, disable, version).

### 1.4 Key Stakeholders

| Role | Description |
|------|-------------|
| **Platform Admin** | Client’s internal team managing the SaaS (optional; may be same as Tenant Admin). |
| **Tenant Admin** | Client users who manage their stores and agents. |
| **Store Manager** | (Optional) Users scoped to one store. |
| **End Customer** | Caller who interacts with a voice agent. |

### 1.5 Out of Scope for This PRD

- Building the underlying LLM, TTS, or STT models.
- Shopify app listing or public app distribution.
- Billing, subscriptions, or usage-based pricing (can be added later).
- White-label or reseller multi-tenancy (multiple independent “clients” on same infrastructure).

---

## 2. MVP Scope

The MVP delivers the **minimum set of features** to run multiple configurable voice agents across multiple stores for a **single tenant**.

### 2.1 In Scope for MVP

| Area | MVP Deliverable |
|------|-----------------|
| **Tenancy** | Single tenant (the client). Tenant and store hierarchy modeled; multi-tenant data isolation in place for future use. |
| **Stores** | CRUD for Shopify stores; one store = one Shopify connection (API credentials / store identity). |
| **Agents** | CRUD for voice agents per store. Each agent: name, description, enabled/disabled, version (e.g., draft vs active). |
| **Agent configuration** | Per agent: system prompt, personality, store context (e.g., branch details, hours), FAQs (structured Q&A). |
| **Tools** | At least one tool category: e.g., “books,” “inventory,” “orders,” “delivery,” “store hours,” “policies,” “branch-specific.” Configurable per agent (which tools are on/off). |
| **Phone mapping** | Map phone number(s) to agent(s). One number → one agent for MVP; support for multiple numbers per agent. |
| **Admin dashboard** | Web UI: manage tenant (if multi-tenant later), stores, agents; edit config, prompts, FAQs, tools, phone numbers; enable/disable agents. |
| **Voice runtime** | Inbound call → identify agent by phone number → run agent with STT/TTS and LLM; execute allowed tools (e.g., Shopify APIs, store hours). |
| **Manual versioning** | Create new version of an agent (copy config); edit; set one version as “active” for production calls. |
| **Observability (MVP)** | Logging and basic metrics (e.g., call count, errors); no advanced analytics. |

### 2.2 MVP User Stories (Summary)

- As a **Tenant Admin**, I can add my Shopify stores and configure API access so agents can use store data.
- As a **Tenant Admin**, I can create an agent per store, set its prompt, personality, FAQs, and store context.
- As a **Tenant Admin**, I can enable/disable tools (books, inventory, orders, delivery, hours, policies, branches) per agent.
- As a **Tenant Admin**, I can assign a phone number to an agent so that inbound calls to that number use that agent.
- As a **Tenant Admin**, I can create a new version of an agent, edit it, and set it as active without affecting the previous version.
- As a **Tenant Admin**, I can enable or disable an agent so it no longer answers calls.
- As an **End Customer**, I can call a store’s number and be answered by the correct voice agent with accurate, store-specific information.

---

## 3. Non-MVP Scope

The following are **explicitly out of MVP** and planned for later phases.

| Area | Description |
|------|-------------|
| **Multiple tenants** | Multiple independent clients (different companies) on the same platform with full data and billing isolation. |
| **Store-level roles** | Store Manager role with permissions limited to one store. |
| **Advanced analytics** | Dashboards for call volume, CSAT, intent breakdown, A/B tests. |
| **Conversation replay / QA** | Listen to or read transcripts of calls for quality assurance. |
| **Self-service provisioning** | Sign-up, onboarding, and store connection without manual setup. |
| **Billing & metering** | Usage-based billing, plan limits, overage handling. |
| **Advanced routing** | IVR, time-based or skill-based routing to different agents. |
| **Custom TTS/STT** | Choice of voice providers or custom voices per agent. |
| **Webhooks / integrations** | Notify external systems on call start/end or intent. |
| **Public API** | REST or GraphQL API for external automation of agent/store management. |
| **A/B testing** | Run multiple agent versions with traffic split. |

---

## 4. Functional Requirements

### 4.1 Tenant & Store Management

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-T1 | System SHALL support a tenant entity (e.g., organization) that owns one or more stores. | P0 |
| FR-T2 | System SHALL support a store entity linked to one tenant and one Shopify store (store ID, API credentials or OAuth). | P0 |
| FR-T3 | Tenant Admin SHALL be able to create, read, update, and delete (CRUD) stores. | P0 |
| FR-T4 | Store SHALL have at least: display name, Shopify store identifier, and secure storage of API credentials. | P0 |

### 4.2 Agent Management

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-A1 | Each agent SHALL belong to exactly one store. | P0 |
| FR-A2 | Tenant Admin SHALL be able to create, read, update, and delete agents. | P0 |
| FR-A3 | Each agent SHALL have: name, description, enabled/disabled state. | P0 |
| FR-A4 | Tenant Admin SHALL be able to enable or disable an agent; disabled agents SHALL NOT answer calls. | P0 |
| FR-A5 | System SHALL support at least a simple version model: e.g., draft vs active; Tenant Admin SHALL be able to create a new version from an existing agent and set one version as active. | P0 |

### 4.3 Agent Configuration

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-C1 | Each agent SHALL have a configurable system prompt (text). | P0 |
| FR-C2 | Each agent SHALL have configurable personality (e.g., tone, style) as part of prompt or separate field. | P0 |
| FR-C3 | Each agent SHALL have configurable store context (e.g., branch addresses, hours, policies). | P0 |
| FR-C4 | Each agent SHALL have configurable FAQs (e.g., question–answer pairs or structured content). | P0 |
| FR-C5 | Each agent SHALL have configurable tool set: which of the following are enabled—books, inventory, orders, delivery, store hours, policies, branch-specific details. | P0 |
| FR-C6 | Configuration SHALL be versioned with the agent (per-version config). | P0 |

### 4.4 Phone Number Mapping

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-P1 | System SHALL support mapping of phone number(s) to agent(s). | P0 |
| FR-P2 | For MVP: one phone number SHALL map to at most one agent; one agent MAY have multiple phone numbers. | P0 |
| FR-P3 | Tenant Admin SHALL be able to add, remove, and list phone number mappings for an agent. | P0 |
| FR-P4 | Inbound call SHALL be routed to the agent associated with the called number. | P0 |

### 4.5 Voice Runtime & Tools

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-V1 | System SHALL accept inbound voice calls and route them to the correct agent by called number. | P0 |
| FR-V2 | System SHALL use STT (speech-to-text) and TTS (text-to-speech) for the conversation. | P0 |
| FR-V3 | System SHALL run the agent’s LLM with the agent’s prompt, personality, store context, and FAQs. | P0 |
| FR-V4 | System SHALL execute only the tools enabled for that agent (books, inventory, orders, delivery, hours, policies, branch-specific). | P0 |
| FR-V5 | Tools SHALL have access to the agent’s store context (e.g., Shopify API credentials) to answer questions about that store. | P0 |
| FR-V6 | System SHALL support questions about: books, inventory, orders, delivery, store hours, policies, and branch-specific details, when the corresponding tools are enabled. | P0 |

### 4.6 Admin Dashboard

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-D1 | Tenant Admin SHALL have a web-based dashboard to manage stores and agents. | P0 |
| FR-D2 | Dashboard SHALL allow editing agent prompt, personality, store context, FAQs, tool toggles, and phone number mapping. | P0 |
| FR-D3 | Dashboard SHALL allow creating a new agent version and setting the active version. | P0 |
| FR-D4 | Dashboard SHALL show agent status (enabled/disabled) and which version is active. | P0 |

---

## 5. Non-Functional Requirements

### 5.1 Performance

| ID | Requirement |
|----|-------------|
| NFR-P1 | Voice runtime SHALL respond with first TTS playback within **&lt; 3 seconds** of user speech end under normal load. |
| NFR-P2 | Admin dashboard page load (initial meaningful content) SHALL be **&lt; 3 seconds** under normal conditions. |
| NFR-P3 | Tool execution (e.g., Shopify API calls) SHALL complete within **&lt; 5 seconds** for typical queries. |

### 5.2 Availability

| ID | Requirement |
|----|-------------|
| NFR-A1 | Voice call handling SHALL be available **99.5%** over a calendar month (excluding planned maintenance). |
| NFR-A2 | Admin dashboard SHALL be available **99.9%** over a calendar month. |

### 5.3 Usability

| ID | Requirement |
|----|-------------|
| NFR-U1 | Critical admin flows (create agent, edit config, assign phone number) SHALL be completable without documentation for a trained admin. |
| NFR-U2 | Destructive actions (delete agent, remove phone mapping) SHALL require explicit confirmation. |

### 5.4 Compliance & Operations

| ID | Requirement |
|----|-------------|
| NFR-C1 | Storage of Shopify credentials and PII SHALL follow security best practices (encryption at rest, least-privilege access). |
| NFR-C2 | System SHALL support deployment via standard DevOps practices (CI/CD, infrastructure as code). |

---

## 6. Multi-Tenant Architecture Requirements

MVP assumes **one tenant**; architecture SHALL support **future multi-tenancy** without redesign.

### 6.1 Data Isolation

| ID | Requirement |
|----|-------------|
| MTA-1 | **Tenant** SHALL be the top-level isolation boundary; all stores and agents SHALL be scoped to a tenant. |
| MTA-2 | All data access (stores, agents, config, phone mappings, call metadata) SHALL be filtered by tenant ID. |
| MTA-3 | No API or query SHALL return data belonging to another tenant. |
| MTA-4 | Database schema SHALL include `tenant_id` (or equivalent) on all tenant-scoped tables; indexes SHALL support tenant-scoped queries. |

### 6.2 Identity & Access

| ID | Requirement |
|----|-------------|
| MTA-5 | Users SHALL be associated with a tenant; authentication SHALL enforce tenant context. |
| MTA-6 | Authorization SHALL enforce that a user can only access resources (stores, agents) within their tenant. |
| MTA-7 | Design SHALL allow future extension to per-store or role-based permissions (e.g., Store Manager). |

### 6.3 Runtime Isolation

| ID | Requirement |
|----|-------------|
| MTA-8 | Voice runtime SHALL resolve agent (and thus tenant/store) from phone number only; no cross-tenant data SHALL be used in a call. |
| MTA-9 | Tool execution (e.g., Shopify API) SHALL use only the credentials and context of the agent’s store. |
| MTA-10 | Logging and metrics SHALL include tenant (and preferably store/agent) dimensions for filtering and alerting. |

### 6.4 Configuration & Deployment

| ID | Requirement |
|----|-------------|
| MTA-11 | Feature flags and configuration SHALL be supportable per tenant in the future without code change. |
| MTA-12 | Deployment model SHALL support shared infrastructure (single deployment serving one or more tenants) for cost efficiency. |

---

## 7. Security Requirements

### 7.1 Authentication & Authorization

| ID | Requirement |
|----|-------------|
| SEC-1 | Admin users SHALL authenticate via a secure mechanism (e.g., OAuth 2.0 / OIDC or secure username/password with hashing). |
| SEC-2 | Sessions SHALL use secure, HttpOnly cookies or equivalent; session timeout SHALL be configurable. |
| SEC-3 | All admin API requests SHALL be authorized; unauthenticated or unauthorized requests SHALL receive 401/403. |
| SEC-4 | Principle of least privilege: admin roles SHALL have only the permissions required for their function. |

### 7.2 Data Protection

| ID | Requirement |
|----|-------------|
| SEC-5 | Shopify API credentials (tokens, secrets) SHALL be encrypted at rest. |
| SEC-6 | PII (e.g., caller identity, order details used in calls) SHALL be handled per privacy policy; access SHALL be logged. |
| SEC-7 | Secrets SHALL NOT appear in logs, error messages, or client-side code. |

### 7.3 Network & Communication

| ID | Requirement |
|----|-------------|
| SEC-8 | All admin dashboard and API traffic SHALL use TLS (HTTPS). |
| SEC-9 | Voice signaling and media SHALL use secure protocols as required by the telephony provider. |

### 7.4 Operational Security

| ID | Requirement |
|----|-------------|
| SEC-10 | Access to production data and secrets SHALL be auditable (who, when). |
| SEC-11 | Dependencies SHALL be regularly reviewed for known vulnerabilities; critical issues SHALL be remediated on a defined SLA. |

---

## 8. Observability Requirements

### 8.1 Logging

| ID | Requirement |
|----|-------------|
| OBS-1 | Application SHALL emit structured logs (e.g., JSON) with consistent fields: timestamp, level, service, tenant_id, store_id, agent_id, request_id/call_id where applicable. |
| OBS-2 | Logs SHALL be aggregated in a central store (e.g., log aggregation service) searchable by tenant, store, agent, and time. |
| OBS-3 | Errors and failures SHALL be logged with sufficient context to diagnose without PII where possible. |

### 8.2 Metrics

| ID | Requirement |
|----|-------------|
| OBS-4 | System SHALL expose metrics for: inbound call count, call duration, tool call count/latency, error rate (by tenant/store/agent). |
| OBS-5 | Admin API SHALL expose request count, latency, and error rate by endpoint and tenant. |
| OBS-6 | Metrics SHALL be dimensioned by tenant_id (and store_id/agent_id where useful) for multi-tenant visibility. |

### 8.3 Alerting & Health

| ID | Requirement |
|----|-------------|
| OBS-7 | Critical failures (e.g., voice runtime down, auth provider unreachable) SHALL trigger alerts to operators. |
| OBS-8 | Health checks (e.g., /health) SHALL be available for load balancers and orchestration. |
| OBS-9 | (Post-MVP) Dashboards SHALL allow operators to view call volume, errors, and latency by tenant/store/agent. |

### 8.4 Tracing (Optional for MVP)

| ID | Requirement |
|----|-------------|
| OBS-10 | Design SHALL allow future addition of distributed tracing (e.g., trace_id across voice pipeline and tool calls). |

---

## 9. Scalability Requirements

### 9.1 Horizontal Scaling

| ID | Requirement |
|----|-------------|
| SCL-1 | Voice runtime components SHALL be stateless where possible so that additional instances can handle more concurrent calls. |
| SCL-2 | Admin API and dashboard backend SHALL be deployable as multiple instances behind a load balancer. |

### 9.2 Data & Storage

| ID | Requirement |
|----|-------------|
| SCL-3 | Database SHALL support expected growth: 1 tenant, 7+ stores, multiple agents per store, and future additional tenants. |
| SCL-4 | Configuration and metadata SHALL be stored in a durable store; caching (e.g., agent config by phone number) SHALL be invalidatable on update. |

### 9.3 Rate Limits & Quotas

| ID | Requirement |
|----|-------------|
| SCL-5 | Design SHALL support rate limiting per tenant (and per store/agent if needed) to protect upstream services (e.g., Shopify API). |
| SCL-6 | Telephony provider limits (concurrent calls, numbers) SHALL be documented and monitored. |

### 9.4 Targets (Guidance)

| Metric | MVP Target | Note |
|--------|------------|------|
| Concurrent voice calls | 10–50 | Per tenant or global depending on deployment. |
| Stores per tenant | 7–20 | Schema and queries should not assume a fixed cap. |
| Agents per store | 1–5 | No hard limit in MVP; config storage should scale. |
| Admin users per tenant | 1–10 | Auth and session design should support this. |

---

## 10. Risks and Constraints

### 10.1 Technical Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Voice/telephony provider outage** | Calls fail or degrade. | Choose provider with SLA; design for failover or graceful degradation; document dependency. |
| **LLM latency or availability** | Slow or failed responses. | Set latency budgets; use timeouts and fallback messages; consider fallback provider. |
| **Shopify API rate limits** | Tools fail under load. | Implement rate limiting and backoff; cache where appropriate; monitor usage. |
| **Misconfiguration (wrong prompt/tools)** | Agent gives wrong or unsafe answers. | Review workflow in dashboard; versioning and “set active” to reduce accidental rollout; optional approval step later. |

### 10.2 Operational Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Credential leakage** | Unauthorized access to Shopify or platform. | Encrypt at rest; restrict access; rotate credentials; audit access. |
| **Insufficient observability** | Hard to diagnose production issues. | Implement logging and metrics per §8; define runbooks for common failures. |
| **Single region** | Regional outage affects all tenants. | Document; plan for multi-region in future if required. |

### 10.3 Business / Scope Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Scope creep** | MVP delayed. | Strict MVP vs non-MVP (§2, §3); change control for new features. |
| **Multi-tenant assumptions wrong** | Future migration costly. | Implement tenant_id and isolation in MVP; avoid tenant-specific hacks. |

### 10.4 Constraints

| Constraint | Description |
|------------|-------------|
| **Single tenant in MVP** | First release serves one client; multi-tenant billing and sign-up are out of scope. |
| **Manual agent versioning** | No A/B or automated canary in MVP; “active” version is manually selected. |
| **No public API in MVP** | All management via admin dashboard only. |
| **Telephony dependency** | Voice capability depends on chosen provider (Twilio, etc.); provider limits apply. |
| **Shopify API** | Features are limited by Shopify API capabilities and rate limits. |

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **Tenant** | Top-level customer entity (e.g., organization) that owns stores and agents. |
| **Store** | A Shopify store; one per Shopify store connection. |
| **Agent** | An AI voice agent belonging to one store; has config, prompt, tools, FAQs, and phone mapping. |
| **Active version** | The agent version used for production inbound calls. |
| **Tool** | A capability the agent can use (e.g., query inventory, orders, store hours). |
| **Voice runtime** | The system that handles the call (STT, LLM, tools, TTS) for a given agent. |

---

## Appendix B: Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-03-06 | — | Initial client-ready technical PRD. |

---

*End of document.*
