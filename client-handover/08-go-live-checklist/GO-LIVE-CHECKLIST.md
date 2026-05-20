# Go-Live Checklist — AI Voice Agents for Bookstores

Use this checklist before and during production launch. Sign off each section before go-live.

---

## 1. Product readiness

| # | Item | Owner | Done |
|---|------|--------|------|
| 1.1 | Auth / tenant context working | Tech | ☐ |
| 1.2 | Tenant isolation verified (no cross-tenant access) | Tech | ☐ |
| 1.3 | Stores CRUD stable | Tech | ☐ |
| 1.4 | Agents CRUD stable | Tech | ☐ |
| 1.5 | Shopify connection verified (test store) | Tech | ☐ |
| 1.6 | Twilio inbound call flow working | Tech | ☐ |
| 1.7 | OpenAI runtime + tool calling stable | Tech | ☐ |
| 1.8 | Knowledge base (FAQs, branches, documents) active | Tech | ☐ |
| 1.9 | Analytics and call tracking active | Tech | ☐ |
| 1.10 | Fallback and handoff / escalation working | Tech | ☐ |

---

## 2. Operational readiness

| # | Item | Owner | Done |
|---|------|--------|------|
| 2.1 | All production env vars set | Tech | ☐ |
| 2.2 | Secrets configured (no plaintext in code/logs) | Tech | ☐ |
| 2.3 | Staging tested end-to-end | Tech | ☐ |
| 2.4 | Production deploy tested (smoke tests) | Tech | ☐ |
| 2.5 | Database backups enabled and tested | Tech | ☐ |
| 2.6 | Alerts configured (e.g. Sentry, health failures) | Tech | ☐ |
| 2.7 | Domain and SSL ready for webhook URL | Tech | ☐ |
| 2.8 | Twilio numbers mapped to correct agents | Ops | ☐ |
| 2.9 | Live Shopify stores connected (not test only) | Ops | ☐ |

---

## 3. Business / client readiness

| # | Item | Owner | Done |
|---|------|--------|------|
| 3.1 | Client trained: how to create and edit agents | Ops | ☐ |
| 3.2 | Client trained: how to update prompts and publish | Ops | ☐ |
| 3.3 | Client trained: how to connect and reconnect stores | Ops | ☐ |
| 3.4 | Client trained: how to review calls and QA | Ops | ☐ |
| 3.5 | Escalation process and contacts documented and shared | Ops | ☐ |
| 3.6 | Acceptance criteria agreed and signed off | Both | ☐ |

---

## 4. Pre-launch technical checks

- [ ] **Health**: `GET /api/health` and `GET /api/health/ready` return expected status.
- [ ] **Twilio**: Inbound webhook URL correct; signature validation on; test call completes.
- [ ] **OpenAI**: API key valid; realtime session starts; tools execute.
- [ ] **Shopify**: At least one store connected; token valid; scopes sufficient.
- [ ] **Rate limits**: Configured; webhooks excluded where required.
- [ ] **Idempotency**: Twilio status callback does not duplicate events on retries.

---

## 5. Rollout plan (phased)

| Phase | Scope | Duration | Sign-off |
|-------|--------|----------|----------|
| Phase 1 | 1 store, 1 agent, limited hours | Week 1–2 | ☐ |
| Phase 2 | 2–3 stores, monitored rollout | Week 3–4 | ☐ |
| Phase 3 | All active stores | Week 5+ | ☐ |

---

## 6. Post-launch first week

- [ ] Daily: Check failed calls, escalations, top missing FAQs, tool failures.
- [ ] Daily: Confirm Twilio webhook and OpenAI session success rate.
- [ ] End of week: Review analytics (resolution rate, escalation rate, top intents).
- [ ] End of week: Client feedback session and prompt/FAQ tweaks logged.

---

## 7. Sign-off

| Role | Name | Date |
|------|------|------|
| Technical lead | | |
| Client / Product owner | | |
| Operations / Support lead | | |

**Go-live date:** ________________
