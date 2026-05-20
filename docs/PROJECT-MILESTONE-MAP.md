# Full project milestone map

End-to-end roadmap from blueprint to launch and handover.

---

| Step | Focus | Outcomes |
|------|--------|----------|
| **Step 1** | Product blueprint + architecture freeze | Scope, personas, tech stack, high-level architecture. |
| **Step 2** | Monorepo + skeleton + schema base | Repo structure, Prisma schema, base modules, multi-tenant foundation. |
| **Step 3** | Auth + tenant + stores/agents CRUD + prompt versioning | Login, tenants, stores, agents, phone numbers, prompt versions. |
| **Step 4** | Shopify integration + tools foundation | Shopify connection, product/order tools, tool registry. |
| **Step 5** | Twilio inbound flow + routing + runtime skeleton | Inbound webhook, agent resolution, session creation, TwiML, websocket relay. |
| **Step 6** | OpenAI realtime + tool calling + live voice | Realtime (or chat) + tools, tool orchestrator, voice runtime, prompt builder. |
| **Step 7** | Knowledge base + RAG + branch-aware answers | FAQs, branch profiles, documents, vector store, retrieval orchestrator, KB tools. |
| **Step 8** | Analytics + QA + observability | Call events, outcomes, agent/store/tool analytics, QA review, dashboard. |
| **Step 9** | Production hardening + deployment + security | Twilio validation, encryption, rate limits, idempotency, health, CI, tenant isolation, runbooks. |
| **Step 10** | Launch + handover + SOPs + roadmap v2 | Go-live checklist, admin manual, technical handover, SOPs, runbooks, access inventory, pilot plan, roadmap v2, maintenance proposal. |

---

## Next directions (post–Step 10)

- **Direction A:** File-by-file implementation prompts and targeted improvements (e.g. auth, RBAC, missing features).
- **Direction B:** Master build plan — module-wise, file-wise, prompt-wise, and execution-wise implementation map for the whole project.

Use the **client-handover** package for delivery and ongoing operations; use this map for planning and reporting.
