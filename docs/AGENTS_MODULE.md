# Agents Module — Summary

The Agents module is a full CRUD + connection-test flow for Shopify voice AI agents, integrated into the existing SaaS admin platform.

---

## Files changed / added

### Frontend (apps/web)

| File | Change |
|------|--------|
| `lib/api/agents.ts` | Added `databaseConnectionStatus` to `AgentListItem` and `getAgents()` mapping; payload types unchanged. |
| `components/agents/AgentsDashboard.tsx` | Added Database column and badge; use shared `EmptyState`; table `min-w` set to 800px. |
| `components/agents/AgentDetailsView.tsx` | Replaced single “Test integrations” with three actions: **Test Shopify**, **Test Database**, **Test Twilio**; each calls `testAgentConnection(agentId, target)` and runs `router.refresh()` on success. |
| `components/agents/CreateAgentForm.tsx` | Stripped `promptTemplate` from create/update payload; added “Escalation contact” label and “Human handoff” checkbox label; **Review** step now shows full summary (Basic, Voice, Shopify, Database/Knowledge, Twilio, AI, Customer rules). |
| `components/agents/CreateAgentStepper.tsx` | Step labels: “AI & rules”, “Review”; card container, step circles, and connector styling updated. |
| `components/agents/EmptyState.tsx` | Styling aligned with dashboard (border, card, primary button). |
| `app/dashboard/agents/error.tsx` | Buttons use app styling (foreground/background). |
| `app/dashboard/agents/[id]/error.tsx` | Same. |
| `app/dashboard/agents/[id]/edit/error.tsx` | Same. |

### Backend (apps/api)

- No schema or controller changes. Existing `Agent` model, `AgentsController`, `AgentsService`, connection-test services, and DTOs already support all required fields and test endpoints.

---

## Routes

| Method | Path | Description |
|--------|------|-------------|
| **Frontend (Next.js)** | | |
| GET | `/dashboard/agents` | Agents listing (search, filter, table, empty/loading/error). |
| GET | `/dashboard/agents/new` | Create agent (stepper form). |
| GET | `/dashboard/agents/[id]` | Agent details (sections + Test Shopify / DB / Twilio). |
| GET | `/dashboard/agents/[id]/edit` | Edit agent (same form as create, pre-filled). |
| **API (NestJS, prefix `/api`)** | | |
| GET | `/api/agents` | List agents (tenant-scoped). |
| GET | `/api/agents/:id` | Get one agent. |
| POST | `/api/agents` | Create agent. |
| PATCH | `/api/agents/:id` | Update agent. |
| DELETE | `/api/agents/:id` | Soft-delete agent. |
| POST | `/api/agents/test-credentials/shopify` | Test Shopify (no agent). |
| POST | `/api/agents/test-credentials/database` | Test DB (no agent). |
| POST | `/api/agents/test-credentials/twilio` | Test Twilio (no agent). |
| POST | `/api/agents/:id/test-shopify` | Test Shopify for agent (optional body to override). |
| POST | `/api/agents/:id/test-database` | Test DB for agent. |
| POST | `/api/agents/:id/test-twilio` | Test Twilio for agent. |

---

## Data model (Agent)

Persistence is in **PostgreSQL** via **Prisma** (`apps/api/prisma/schema.prisma`). Relevant fields:

- **Basic:** `name`, `slug`, `storeName`, `storeUrl`, `status` (DRAFT | ACTIVE | PAUSED | DISABLED), `language`, `timezone`
- **Voice:** `voiceProvider`, `voiceId`, `voiceStyle`, `greetingMessage`, `fallbackMessage`
- **Shopify:** `shopifyStoreUrl`; secrets in `secretsEnc` (encrypted): admin token, API key, API secret, webhook secret
- **Database / Knowledge:** `databaseProvider`; in `secretsEnc`: `databaseUrl`, `databaseAccessToken`; `knowledgeBaseSource`, `knowledgeSyncEnabled`
- **Twilio:** in `secretsEnc`: `twilioAccountSid`, `twilioAuthToken`; `twilioPhoneNumber`, `callRoutingMode`, `incomingCallHandling`
- **AI:** `baseSystemPrompt`, `agentGoal`, `agentRole`, `toneOfVoice`, `allowedActions`, `restrictedActions`, `escalationInstructions`
- **Customer rules:** `returnRefundBehavior`, `orderStatusHandling`, `outOfStockHandling`, `transferToHumanEnabled`, `escalationPhone`, `escalationEmail`
- **Connection status:** `shopifyConnectionStatus`, `databaseConnectionStatus`, `twilioConnectionStatus`, `lastConnectionTestAt`

Secrets are never returned in API responses; they are stored in `secretsEnc` and merged on update when new secret values are sent.

---

## How to test the full feature

1. **Run backend and DB**
   - From repo root: `pnpm db:generate` then `pnpm db:migrate` (if not done).
   - Start API: `pnpm dev` (runs web + api via Turbo) or `pnpm dev -w api` (API only on port 3001).

2. **Run frontend**
   - If not using `pnpm dev`: `pnpm dev -w web` (port 3000).

3. **Environment**
   - Web: `NEXT_PUBLIC_API_URL=http://localhost:3001` (default), `NEXT_PUBLIC_TENANT_ID` (default `default-tenant`).
   - API: `DATABASE_URL` set; tenant `default-tenant` must exist (create via Prisma/seed or API if required).

4. **Flows to test**
   - **List:** Open `/dashboard/agents` → empty state or table; search and status filter.
   - **Create:** “Create Agent” → step 1 (Basics) → Next → step 2 (Integrations: Shopify, DB, Twilio) → Test connection for each (optional) → step 3 (Voice, AI, Customer rules) → step 4 (Review) → “Create agent” or “Save as draft”.
   - **Detail:** Click an agent → details with Basic, Voice, Shopify, DB, Twilio, AI, Customer rules, Connection health; use **Test Shopify**, **Test Database**, **Test Twilio** (status and “Last tested” update after refresh).
   - **Edit:** “Edit agent” → same stepper with pre-filled data; change fields, optional “Test connection”; “Update agent” or “Save as draft”.
   - **Actions:** From list dropdown or details: View, Edit, Duplicate, Pause/Activate, Delete (with confirm modal).
   - **Validation:** Submit with missing required fields (e.g. agent name, store name); optional URL/email validation.
   - **Secrets:** Masked inputs (Show/Hide); leave blank on edit to keep existing values; Review step shows “••••••••” for secrets.

5. **Connection tests**
   - Create flow: fill Shopify URL + Admin token (or DB URL/token, or Twilio SID + token) and click “Test connection” in the relevant section.
   - Detail page: use “Test Shopify”, “Test Database”, “Test Twilio”; backend updates `*ConnectionStatus` and `lastConnectionTestAt`; refresh to see new status.

This covers listing, create, edit, details, persistence, validation, masked secrets, review step, and connection tests for Shopify, DB, and Twilio.
