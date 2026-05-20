# Master Build Plan — AI Voice Agents for Bookstores

Single source of truth for build phases, module order, file map, and Cursor strategy.

---

## 1. Final goal

**A multi-tenant SaaS platform for managing multiple Shopify-connected AI voice agents using Twilio + OpenAI + Knowledge Base + Analytics.**

- Admin dashboard: connect multiple Shopify stores, create voice agents per store, assign Twilio numbers.
- Customer calls → agent answers in live voice using Shopify data, FAQ, policies, branch info.
- Logs, analytics, and QA included.

---

## 2. Stack (frozen)

| Layer | Tech |
|-------|------|
| Frontend | Next.js, TypeScript, Tailwind, shadcn/ui |
| Backend | NestJS, Prisma, PostgreSQL, Redis, BullMQ |
| Voice / AI | Twilio, OpenAI Realtime, internal tool orchestrator |
| Commerce | Shopify Admin GraphQL API |
| Infra | Vercel (web), Railway/Render/AWS (API), S3/R2, Sentry, PostHog |

---

## 3. Build stages

- **Stage A — Core SaaS:** Monorepo, auth, tenant, stores, agents, prompts.
- **Stage B — AI Voice Commerce:** Shopify connection, tools, Twilio inbound, realtime runtime, OpenAI tool calling.
- **Stage C — Production:** KB/RAG, analytics, QA, security, deployment, handover docs.

---

## 4. Build sequence (10 phases)

| Phase | Focus |
|-------|--------|
| 1 | Repo + schema + local infra |
| 2 | Auth + tenant + users |
| 3 | Stores + agents + prompt versioning |
| 4 | Shopify integration + tools |
| 5 | Phone numbers + Twilio inbound |
| 6 | Voice runtime + OpenAI realtime |
| 7 | Knowledge base + branch profiles + FAQs |
| 8 | Analytics + QA + call insights |
| 9 | Security + hardening + deployment |
| 10 | Client handover + SOPs + launch pack |

---

## 5. Repo structure (target)

```
bookstore-voice-agents/
├── apps/
│   ├── web/
│   └── api/
├── packages/
│   ├── types/
│   ├── config/
│   ├── ui/
│   └── eslint-config/
├── infra/
│   ├── docker/
│   ├── scripts/
│   └── docs/
├── .github/workflows/
├── package.json
├── turbo.json
├── pnpm-workspace.yaml
└── .env.example
```

---

## 6. Backend module map

```
apps/api/src/
├── common/
├── database/
├── modules/
│   ├── auth/
│   ├── tenants/
│   ├── users/
│   ├── stores/
│   ├── agents/
│   ├── prompts/
│   ├── phone-numbers/
│   ├── calls/
│   ├── transcripts/
│   ├── tools/
│   ├── knowledge/
│   ├── analytics/
│   ├── audit-logs/
│   └── integrations/
│       ├── shopify/
│       ├── twilio/
│       └── openai/
└── prisma/
    └── schema.prisma
```

---

## 7. Frontend page map

```
apps/web/app/
├── (auth)/
├── dashboard/
│   ├── page.tsx
│   ├── stores/
│   ├── agents/
│   ├── phone-numbers/
│   ├── calls/
│   ├── knowledge/
│   ├── analytics/
│   ├── qa/
│   └── settings/
```

---

## 8. System rules (never break)

1. Every query **tenant-scoped**.
2. **Soft delete** where sensible.
3. **Secrets** never in response.
4. **Prompt versioning** — no overwrite; versions only.
5. **Order lookup** only with verified identifiers.
6. Model has **no raw Shopify access** — only via tools.
7. Tools return **normalized JSON** only.
8. Important changes **audit logged**.

---

## 9. Implementation loop (per module)

1. Prisma model  
2. DTOs  
3. Service  
4. Controller  
5. Module  
6. Test endpoint  
7. Frontend page  
8. Frontend components  

---

## 10. Cursor workflow

- **Method A:** Create file manually → open in editor → paste file-specific prompt (see `docs/CURSOR-PROMPTS/`).
- **Method B:** “Create file at path X. Write complete code. Do not explain. Actually create the file.”
- One prompt per file; production-ready code only; no pseudo-code or long plans in the same message.

---

## 11. Weekly execution (suggested)

| Week | Focus |
|------|--------|
| 1 | Monorepo, auth, tenant, stores |
| 2 | Agents, prompts, dashboard core UI |
| 3 | Shopify connection, product/order tools |
| 4 | Twilio inbound, phone numbers, call sessions |
| 5 | OpenAI realtime, runtime, transcript |
| 6 | Tool calling in live voice, fallback, handoff |
| 7 | FAQs, branch profiles, knowledge docs |
| 8 | Retrieval/vector, voice KB integration |
| 9 | Analytics, QA, daily metrics |
| 10 | Security, deployment, handover docs |

---

## 12. Must-build DB models (order)

Tenant, User, TenantMembership, Store, ShopifyConnection, Agent, PromptVersion, PhoneNumber, CallSession, CallTranscript, ToolExecution, BranchProfile, StoreFAQ, KnowledgeDocument, CallEvent, CallOutcome, AgentQualityReview, DailyAgentMetrics, AuditLog.

---

## 13. First sprint (if starting fresh)

**Sprint 1:** Milestone 1 + 2 + 3 → Repo, auth, tenant, stores, agents, prompts.

File-by-file Cursor prompts for each module live in `docs/CURSOR-PROMPTS/` (e.g. `stores-module.md`).
