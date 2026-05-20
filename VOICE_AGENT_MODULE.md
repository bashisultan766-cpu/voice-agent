# Voice Agent Module — Implementation Summary

This document summarizes the **Voice Agent Module** for the Shopify SaaS project: what was built, which files were changed, API routes, and how to test and run the module locally.

---

## 1. Files Changed or Created

### Backend (API — NestJS + Prisma)

| File | Change |
|------|--------|
| `apps/api/prisma/schema.prisma` | Added `openaiConnectionStatus` and `elevenlabsConnectionStatus` to `Agent` model. |
| `apps/api/src/modules/agents/dto/create-agent.dto.ts` | Added per-agent secret fields `openaiApiKey` + `elevenlabsApiKey`. |
| `apps/api/src/modules/agents/dto/update-agent.dto.ts` | No change (inherits from `PartialType(CreateAgentDto)`). |
| `apps/api/src/modules/agents/dto/test-ai.dto.ts` | **New.** DTO for `POST :id/test-ai` body (`sampleQuery`). |
| `apps/api/src/modules/agents/agents.controller.ts` | Added connection-test endpoints for OpenAI + ElevenLabs (create-flow + agent-specific). |
| `apps/api/src/modules/agents/agents.service.ts` | Added encrypted secret storage + validation for OpenAI/ElevenLabs; persisted connection statuses and updated `lastConnectionTestAt`. |
| `apps/api/src/modules/agents/connection-test/shopify-connection-test.service.ts` | Replaced stub with real Shopify Admin API call (`GET .../admin/api/2024-01/shop.json`). |
| `apps/api/src/modules/agents/connection-test/openai-connection-test.service.ts` | **New.** Tests OpenAI API key via `GET /v1/models`. |
| `apps/api/src/modules/agents/connection-test/elevenlabs-connection-test.service.ts` | **New.** Tests ElevenLabs key via `POST /v1/text-to-speech`. |
| `apps/api/src/modules/calls/runtime/session-context.service.ts` | Decrypts and injects per-agent OpenAI/ElevenLabs keys into voice runtime context. |
| `apps/api/src/modules/integrations/openai/openai-voice.service.ts` | Uses per-agent OpenAI API key (falls back to env if missing). |

### Frontend (Web — Next.js)

| File | Change |
|------|--------|
| `apps/web/components/agents/form-types.ts` | Added `storeEmail`, `databaseAccessToken`; extended to 7 steps with `validateStep1`–`validateStep6`; `CreateAgentStep` = 1–7. |
| `apps/web/components/agents/CreateAgentStepper.tsx` | Stepper labels updated to 7 steps: Store, Voice, Shopify, Twilio, AI Prompt, Handling, Review. |
| `apps/web/components/agents/CreateAgentForm.tsx` | 7-step flow: StepStoreInfo, StepVoiceConfig, StepShopify, StepTwilio, StepAIPrompt, StepCustomerHandling, StepReview; added storeEmail/databaseAccessToken; StepReview shows Test Shopify/Database/Twilio; added StepVoiceConfig, StepShopify, StepTwilio, StepAIPrompt, StepCustomerHandling. |
| `apps/web/components/agents/AgentDetailsView.tsx` | Added storeEmail in Basic info; added “Agent performance” (analytics) and “Recent call activity” (logs) using `getAgentAnalytics` and `getAgentLogs`. |
| `apps/web/components/agents/AgentActionsDropdown.tsx` | Added “Upgrade / Enhance” link to edit page. |
| `apps/web/lib/api/agents.ts` | Added `storeEmail` to payload and `agentToFormData`; added `getAgentAnalytics()`, `getAgentLogs()`, `testAgentAi()`; added `databaseAccessToken` to form payload. |

### Documentation

| File | Change |
|------|--------|
| `VOICE_AGENT_MODULE.md` | **New.** This file. |

---

## 2. API Routes Used for Integration

All agent routes are under `/api/agents` (or your backend base path). The Next.js app rewrites `/api/agents` and `/api/agents/*` to the API server.

| Method | Path | Description |
|--------|------|-------------|
| **POST** | `/api/agents` | Create agent (body: `CreateAgentDto`). |
| **GET** | `/api/agents` | List agents for tenant (`x-tenant-id`). |
| **GET** | `/api/agents/:id` | Get one agent. |
| **PATCH** | `/api/agents/:id` | Update agent (body: partial `CreateAgentDto`). |
| **DELETE** | `/api/agents/:id` | Soft-delete agent. |
| **POST** | `/api/agents/test-credentials/shopify` | Test Shopify credentials (no agent). |
| **POST** | `/api/agents/test-credentials/database` | Test database credentials (no agent). |
| **POST** | `/api/agents/test-credentials/twilio` | Test Twilio credentials (no agent). |
| **POST** | `/api/agents/test-credentials/openai` | Test OpenAI credentials (no agent). |
| **POST** | `/api/agents/test-credentials/elevenlabs` | Test ElevenLabs credentials (no agent). |
| **POST** | `/api/agents/:id/test-shopify` | Test Shopify for agent (optional body to override). |
| **POST** | `/api/agents/:id/test-database` | Test database for agent (optional body to override). |
| **POST** | `/api/agents/:id/test-twilio` | Test Twilio for agent (optional body to override). |
| **POST** | `/api/agents/:id/test-openai` | Test OpenAI for agent (optional body to override). |
| **POST** | `/api/agents/:id/test-elevenlabs` | Test ElevenLabs for agent (optional body to override). |
| **GET** | `/api/agents/:id/analytics` | Agent analytics (total/resolved/escalated calls, avg duration, last call). |
| **GET** | `/api/agents/:id/logs` | Recent call sessions for agent (`?limit=50`). |
| **POST** | `/api/agents/:id/test-ai` | Test AI behavior (body: `{ sampleQuery?: string }`). |

**Headers:** All requests must include `x-tenant-id` (e.g. `default-tenant`) and `Content-Type: application/json` for body requests.

---

## 3. Data Structure (Agent)

The **Agent** schema (Prisma) includes (among others):

- **Store:** `storeName`, `storeUrl`, `storeEmail`
- **Voice:** `name`, `voice`, `voiceProvider`, `voiceId`, `voiceStyle`, `language`, `timezone`, `greetingMessage`, `fallbackMessage`
- **Shopify:** `shopifyStoreUrl`; credentials in `secretsEnc` (encrypted)
- **Twilio:** `twilioPhoneNumber`, `callRoutingMode`, `incomingCallHandling`; credentials in `secretsEnc`
- **AI:** `baseSystemPrompt`, `agentRole`, `agentGoal`, `toneOfVoice`, `allowedActions`, `restrictedActions`, `escalationInstructions`
- **Customer handling:** `returnRefundBehavior`, `orderStatusHandling`, `outOfStockHandling`, `transferToHumanEnabled`, `escalationPhone`, `escalationEmail`
- **Connection status:** `shopifyConnectionStatus`, `databaseConnectionStatus`, `twilioConnectionStatus`, `openaiConnectionStatus`, `elevenlabsConnectionStatus`, `lastConnectionTestAt`

Secrets (Shopify token, webhook secret, database URL/token, Twilio SID/auth, OpenAI API key, ElevenLabs API key) are stored in `secretsEnc` and are never returned by the API.

---

## 4. Testing and Running the Module Locally

### Prerequisites

- Node.js 20+
- pnpm (or npm/yarn)
- PostgreSQL (for API)
- Optional: Shopify store (Admin API token) and Twilio account for live connection tests

### 1) Database

- Set `DATABASE_URL` in `apps/api/.env` (or root `.env`).
- From repo root:

```bash
pnpm db:migrate
```

- If you added `storeEmail` and haven’t migrated yet, create a migration:

```bash
cd apps/api
npx prisma migrate dev --name add_agent_store_email
```

- Generate Prisma client:

```bash
pnpm db:generate
```

### 2) API

- Optional: set `ENCRYPTION_KEY` in `apps/api/.env` (32-byte hex) so agent secrets are encrypted.
- From repo root:

```bash
pnpm --filter api dev
```

- API runs at `http://localhost:3001` (or the port in your config).

### 3) Web (Next.js)

- Set `NEXT_PUBLIC_API_URL` to your API URL (e.g. `http://localhost:3001`) and `NEXT_PUBLIC_TENANT_ID` (e.g. `default-tenant`) if needed.
- From repo root:

```bash
pnpm --filter web dev
```

- Open `http://localhost:3000` and go to the Agents section (e.g. `/dashboard/agents`).

### 4) Manual testing

1. **Create agent**  
   Go to **Create Agent** and complete the 7 steps: Store info → Voice → Shopify → Twilio → AI Prompt → Customer handling → Review. Use “Test Shopify” / “Test Database” / “Test Twilio” on the last step (or in the relevant steps). Save as Draft or Active.

2. **List agents**  
   On the agents list you should see the new agent with status and connection badges (Shopify, Database, Twilio).

3. **View agent**  
   Open an agent to see details, **Agent performance** (analytics), and **Recent call activity** (logs). If no calls exist yet, analytics/logs will be empty or zero.

4. **Edit / Upgrade**  
   Use **Edit agent** or **Upgrade / Enhance** (in the row actions dropdown) to change configuration.

5. **Test connections**  
   From the agent detail page or the edit flow, use “Test Shopify”, “Test Database”, “Test Twilio”, “Test OpenAI”, “Test ElevenLabs”. For Shopify, use a valid store URL and Admin API token.

6. **Test AI (optional)**  
   Call `POST /api/agents/:id/test-ai` with body `{ "sampleQuery": "Where is my order?" }` to get a preview response (current implementation returns a composed prompt preview).

7. **Analytics and logs**  
   - `GET /api/agents/:id/analytics` → total/resolved/escalated calls, avg duration, last call.  
   - `GET /api/agents/:id/logs?limit=20` → recent call sessions.

---

## 5. Demo-Ready Checklist

- **Create Agent:** 7-step form with Store, Voice, Shopify, Twilio, AI Prompt, Customer handling, and Review (with connection tests).
- **List agents:** Table with Agent name, Store, Voice, Status, Shopify/Database/Twilio connection status, Last update, and View/Edit/Delete/Upgrade.
- **List agents:** Table with Agent name, Store, Voice, Status, Shopify/Database/Twilio/OpenAI/ElevenLabs connection status, Last update, and View/Edit/Delete/Upgrade.
- **Edit agent:** Same 7-step form pre-filled; credentials can be left blank to keep existing.
- **Delete agent:** Confirmation dialog; agent is soft-deleted.
- **Upgrade / Enhance:** Link from list and detail to edit page.
- **Connection tests:** Test Shopify (real Admin API), Test Database, Test Twilio, Test OpenAI, Test ElevenLabs from create/edit and from Review step.
- **Analytics & logs:** Agent detail page shows performance metrics and recent call activity when data exists.
- **Security:** Secrets stored encrypted when `ENCRYPTION_KEY` is set; never returned in API responses.
- **Responsive UI:** Layout works on desktop and mobile (Tailwind-based).

For a client demo, walk through: Create Agent (all 7 steps) → View agent → Show performance/logs (or explain they appear after calls) → Edit → Test connections → Optional: Test AI endpoint.

---

## 6. Optional: Twilio Connection Test

The Twilio connection test in `apps/api/src/modules/agents/connection-test/twilio-connection-test.service.ts` is still a stub (validates SID/token, then simulates success). To make it real, use the Twilio Node SDK (e.g. `twilioClient.api.accounts(sid).fetch()` or `balance.fetch()`) and add the dependency in `apps/api/package.json`.

---

*End of Voice Agent Module documentation.*
