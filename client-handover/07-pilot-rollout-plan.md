# Pilot rollout plan

Phased rollout reduces risk and surfaces issues early. Use this plan for the first production launch.

---

## Week 1 — Internal testing and tuning

**Goal:** Validate full flow and tune prompts.

| Day | Activity | Owner |
|-----|----------|--------|
| 1–2 | Internal test calls: inbound, tools, KB, escalation | Tech |
| 3 | Sample scenarios for each store type; log gaps | Tech + Ops |
| 4 | Prompt and FAQ tuning based on test transcripts | Ops |
| 5 | Staging sign-off; production deploy and smoke tests | Tech |

**Exit criteria:** At least one successful end-to-end call per agent type; no critical errors in health/logs.

---

## Week 2 — One live store, limited hours

**Goal:** Single store live with daily QA.

| Day | Activity | Owner |
|-----|----------|--------|
| 1 | Go-live: 1 store, 1 agent, limited business hours | Ops |
| 2–7 | Daily QA review: transcripts, tool failures, escalations | Ops |
| 2–7 | Daily log: top intents, missing FAQs, prompt tweaks | Ops |
| 5 | Mid-week review: resolution rate, escalation rate | Both |
| 7 | Decision: expand to 2–3 stores or extend Week 2 | Both |

**Exit criteria:** Client confident in quality; no critical incidents; escalation path tested.

---

## Week 3 — 2–3 stores, KB expansion

**Goal:** Broaden rollout; expand knowledge base.

| Day | Activity | Owner |
|-----|----------|--------|
| 1 | Add 1–2 more stores/agents; same support model | Ops |
| 1–7 | KB expansion: branch profiles, FAQs, policy docs per store | Ops |
| 3 | Analytics review: per-store and per-agent metrics | Ops |
| 7 | Checklist: prompt improvements, FAQ gaps, branch coverage | Both |

**Exit criteria:** Stable resolution/escalation rates; client can run daily QA independently.

---

## Week 4 — Full rollout decision

**Goal:** Decide full rollout and handover.

| Activity | Owner |
|----------|--------|
| Full rollout checklist review | Both |
| All active stores onboarded or scheduled | Ops |
| Support handover: L1/L2/L3 defined and documented | Ops |
| Go-live sign-off (see GO-LIVE-CHECKLIST.md) | Both |
| Schedule first monthly KPI and roadmap review | Both |

---

## Rollback triggers

If any of the following occur, consider pausing rollout or rolling back:

- Incoming calls consistently not answered (webhook/runtime failure).
- Critical tool (e.g. order lookup) failing for multiple stores.
- Data or tenant isolation incident.
- Client-reported safety or compliance issue.

Document rollback steps in the Technical Handover and Incident Runbooks.
