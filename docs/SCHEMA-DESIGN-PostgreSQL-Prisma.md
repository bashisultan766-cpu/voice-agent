# PostgreSQL + Prisma Schema Design
## Multi-Tenant AI Voice Agent Platform

**Document Version:** 1.0  
**Date:** March 6, 2025  
**Role:** Staff Backend Engineer

---

## 1. Entity List

| Entity | Purpose | Soft Delete | Tenant-Scoped |
|--------|---------|-------------|--------------|
| **Tenant** | Top-level organization; isolation boundary | Yes | — (root) |
| **User** | Admin users belonging to a tenant | Yes | Yes (`tenantId`) |
| **Store** | Shopify store; belongs to tenant | Yes | Yes (`tenantId`) |
| **StoreCredential** | Encrypted/vault reference for Shopify API credentials | No (audit trail) | Via Store |
| **TenantIntegration** | Tenant-level integrations (e.g. Twilio); credential refs | Yes | Yes (`tenantId`) |
| **Agent** | AI voice agent; belongs to one store | Yes | Via Store |
| **PromptVersion** | Versioned prompt/config per agent | No (history) | Via Agent |
| **TwilioNumber** | Phone number owned by tenant; assigned to agent | Yes | Yes (`tenantId`) |
| **KnowledgeDocument** | FAQs, policies, branch info per agent | Yes | Via Agent |
| **CallSession** | One record per phone call | No | Yes (`tenantId`) |
| **Transcript** | Conversation transcript for a call (turns in JSONB) | No | Via CallSession |
| **ToolExecution** | Log of each tool call during a session | No | Via CallSession |
| **AuditLog** | Immutable log of admin actions | No | Yes (`tenantId`) |

---

## 2. Table Relationships

```
┌─────────────┐
│   Tenant    │
└──────┬──────┘
       │ 1
       │
       ├───────────────────────────────────────────────────────────────────┐
       │ N                                                                 │ N
       ▼                                                                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐           ┌─────────────────┐
│    User     │     │   Store     │     │TwilioNumber │           │ TenantIntegration│
└─────────────┘     └──────┬──────┘     └──────┬──────┘           └─────────────────┘
                           │ 1                 │ N
                           │                   │ (agentId nullable)
                           │ N                 │ 1
                           ▼                   ▼
                    ┌─────────────┐     ┌─────────────┐
                    │   Agent     │◄────│             │
                    └──────┬──────┘     └─────────────┘
                           │ 1
         ┌─────────────────┼─────────────────┬─────────────────┐
         │ N               │ N               │ 1               │ N
         ▼                 ▼                 ▼                 ▼
┌─────────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────────┐
│ PromptVersion   │ │KnowledgeDoc  │ │ current      │ │  CallSession    │
│ (versioned      │ │              │ │ PromptVersion│ │                 │
│  prompts)       │ │              │ │ (self-ref)   │ └────────┬────────┘
└─────────────────┘ └──────────────┘ └──────────────┘          │ 1
                                                                │
                    ┌───────────────────────────────────────────┼───────────────┐
                    │ N                                         │ N             │ N
                    ▼                                           ▼               ▼
             ┌─────────────┐                            ┌─────────────┐  ┌─────────────┐
             │  AuditLog   │                            │ Transcript  │  │ToolExecution│
             │ (tenantId,  │                            │             │  │             │
             │  userId?)   │                            └─────────────┘  └─────────────┘
             └─────────────┘

┌─────────────────┐
│ StoreCredential │  N:1  Store (storeId)
│ (store-level    │
│  credential ref)│
└─────────────────┘
```

**Relationship summary:**

| From | To | Relation | FK |
|------|-----|----------|-----|
| User | Tenant | N:1 | userId → tenantId |
| Store | Tenant | N:1 | storeId → tenantId |
| StoreCredential | Store | N:1 | storeId |
| TenantIntegration | Tenant | N:1 | tenantId |
| Agent | Store | N:1 | storeId |
| Agent | PromptVersion | 1:1 (current) | currentPromptVersionId → PromptVersion.id |
| PromptVersion | Agent | N:1 | agentId |
| TwilioNumber | Tenant | N:1 | tenantId |
| TwilioNumber | Agent | N:1 (optional) | agentId nullable |
| KnowledgeDocument | Agent | N:1 | agentId |
| CallSession | Tenant, Store, Agent, TwilioNumber | N:1 | tenantId, storeId, agentId, twilioNumberId |
| Transcript | CallSession | N:1 | callSessionId |
| ToolExecution | CallSession | N:1 | callSessionId |
| AuditLog | Tenant, User | N:1 | tenantId, userId (nullable) |

---

## 3. Suggested Prisma Schema Draft

The full schema is in **`prisma/schema.prisma`**. Summary:

- **Enums:** `TenantStatus`, `UserRole`, `UserStatus`, `StoreStatus`, `CredentialStatus`, `IntegrationType`, `AgentStatus`, `PromptVersionStatus`, `TwilioNumberStatus`, `KnowledgeDocumentType`, `KnowledgeDocumentStatus`, `CallDirection`, `CallSessionStatus`, `ToolExecutionStatus`.
- **Models:** `Tenant`, `User`, `Store`, `StoreCredential`, `TenantIntegration`, `Agent`, `PromptVersion`, `TwilioNumber`, `KnowledgeDocument`, `CallSession`, `Transcript`, `ToolExecution`, `AuditLog`.
- **Soft delete:** `deletedAt DateTime?` on Tenant, User, Store, Agent, TwilioNumber, KnowledgeDocument, TenantIntegration.
- **Timestamps:** `createdAt`, `updatedAt` on all models; `startedAt`/`endedAt` on CallSession.
- **Versioning:** `PromptVersion` has `version` (Int), `status` (DRAFT | ACTIVE | ARCHIVED); `Agent.currentPromptVersionId` points to the active version.
- **Relations:** All FKs with appropriate `onDelete` (Cascade for owned children, SetNull where optional). Tables mapped to snake_case via `@@map("table_name")`.

---

## 4. Index Recommendations

### 4.1 Tenant isolation (critical)

- **Every tenant-scoped table:** composite index `(tenant_id, id)` and ensure all list/filter queries include `tenant_id`.
- **Stores:** `(tenant_id)`, `(tenant_id, deleted_at)` for soft-delete filters.
- **Agents:** `(store_id)`, `(store_id, deleted_at)`; store is already tenant-scoped.
- **Users:** `(tenant_id, email)` unique for active users; `(tenant_id, deleted_at)`.

### 4.2 Lookup and routing

- **TwilioNumber:** unique on `phone_number` (E.164); index `(tenant_id, agent_id)` for “numbers by agent”; `(agent_id)` for “numbers for this agent.”
- **CallSession:** `(agent_id, started_at DESC)` for agent call history; `(tenant_id, started_at DESC)` for tenant analytics; `(twilio_call_sid)` unique for webhook idempotency.
- **PromptVersion:** `(agent_id, status)`, `(agent_id, version)` unique.

### 4.3 Analytics and reporting

- **CallSession:** `(tenant_id, status, started_at)`, `(store_id, started_at)`, `(agent_id, started_at)` for dashboards and aggregates.
- **ToolExecution:** `(call_session_id)`, `(call_session_id, created_at)`; optional `(tool_name, created_at)` for tool-level analytics.
- **AuditLog:** `(tenant_id, created_at DESC)`, `(tenant_id, resource_type, resource_id)`, `(user_id, created_at)`.

### 4.4 Soft delete

- Where `deleted_at` is used: include `WHERE deleted_at IS NULL` in all “active” queries; index `(tenant_id, deleted_at)` or `(entity_id, deleted_at)` as needed.

### 4.5 Prisma vs raw indexes

- Prisma schema: use `@@index([tenantId, id])`, `@@unique([phoneNumber])`, etc.
- Partial indexes (e.g. “active only”) and expression indexes: add via raw SQL migrations when needed for performance.

---

## 5. Security Notes

### 5.1 Tenant isolation

- **Never** trust `tenant_id` (or store/agent IDs) from request body or query params. Resolve tenant from authenticated user (JWT/session) and enforce in every query.
- Use a shared pattern: e.g. `requireTenantContext(req)` → `tenantId`; then `prisma.agent.findMany({ where: { store: { tenantId } } })`.
- For voice webhooks (no user): resolve tenant only via **agent_id** derived from **phone number** lookup; then load only that agent’s data.

### 5.2 Credentials

- **StoreCredential** and **TenantIntegration** store **references only** (e.g. vault path, secret name). Application resolves secrets at runtime from a secrets manager; never log or return refs to the client.
- Prefer encryption at rest for any refs that could be sensitive (e.g. which vault path). Application layer or DB-level encryption acceptable.

### 5.3 PII and call data

- **CallSession** may contain caller number; **Transcript** contains conversation. Restrict access by role; consider retention policy and masking in non-production.
- **AuditLog** may log IP and user agent; treat as PII for compliance (access control, retention).

### 5.4 Soft delete and audit

- Soft-deleted rows must be excluded in all normal reads (middleware or repository layer). Hard delete only for legal/compliance with a defined process.
- **AuditLog** is append-only; no updates or deletes. Use for “who changed what” for agents, config, and phone mapping.

### 5.5 SQL injection and ORM

- Use Prisma (parameterized queries) only; avoid raw SQL with string interpolation. If raw SQL is needed (e.g. reporting), use parameterized API only.

---

## 6. Prisma Schema Location

The concrete Prisma schema is in **`prisma/schema.prisma`**. It includes all enums, models, relations, `@@index`, and `@@unique` definitions. Apply any additional indexes (e.g. partial or expression indexes) via raw SQL in migrations as needed.
