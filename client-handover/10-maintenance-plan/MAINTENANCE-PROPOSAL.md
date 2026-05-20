# Maintenance and support proposal

This document outlines recommended support scope and optional tiers for the AI Voice Agents platform after go-live. Adjust scope and pricing to your engagement model.

---

## Support scope (included in base)

- **Uptime monitoring:** Health checks and alerting; notification to technical owner on failure.
- **Minor fixes:** Bug fixes and small config changes (e.g. env, webhook URL) that do not require new features or major refactors.
- **Documentation updates:** Keep handover docs and runbooks in sync with actual behavior and access.

---

## Incident response scope

- **L1 (Admin/Support):** Call review, FAQ updates, minor prompt edits, branch info updates. Handled by client or designated support.
- **L2 (Technical operator):** Shopify reconnect, Twilio number remap, agent tool config, dashboard permissions. Handled by your ops or our ops (as agreed).
- **L3 (Developer/Engineering):** Runtime failure, webhook or OpenAI session issues, DB/data bugs, deployment. Handled by technical owner or engineering team.

Define who performs L1/L2/L3 and response times (e.g. L3 critical within 4 hours) in a separate SLA if needed.

---

## Monthly analytics review (optional)

- **Included in Growth/Premium:** Monthly session to review KPIs (resolution rate, escalation rate, top intents, tool health), QA sample, and prompt/FAQ improvement list.
- **Deliverable:** Short report or dashboard walkthrough and action list.

---

## Prompt optimization support (optional)

- **Included in Growth/Premium:** Review of escalated and low-score calls; suggested prompt and FAQ changes; support implementing and testing changes (per SOP 2 and SOP 3).
- **Exclusions:** Full rewrite of agent personality or new tools; those are project work.

---

## Knowledge base updates (optional)

- **Included in Growth/Premium:** Support adding or updating FAQs, branch profiles, and policy documents; reindexing and testing retrieval. Capped hours per month (e.g. 2–4 hours).
- **Exclusions:** Large document sets or custom parsing; those are project work.

---

## Onboarding support for new stores (optional)

- **Included in Premium:** Full onboarding of new stores/agents per SOP 1 and SOP 2 (config, content, test calls, go-live). Per-store or per-agent fee, or bundled in retainer.
- **Exclusions:** Custom integrations or new tool development.

---

## Exclusions (all tiers)

- New feature development (covered by roadmap or separate SOW).
- Infrastructure or third-party cost (Twilio, OpenAI, hosting, etc.) unless explicitly included.
- Data migration or custom integrations not in standard scope.
- 24/7 on-call unless agreed in a separate SLA.

---

## Optional tiers (example)

| Tier | Focus | Typical inclusions |
|------|--------|---------------------|
| **Basic** | Stability | Uptime monitoring, minor fixes, doc updates, L3 incident response as agreed. |
| **Growth** | Quality and content | Basic + monthly analytics review, prompt optimization support, KB update support (capped hours). |
| **Premium** | Full ops and growth | Growth + new store/agent onboarding, priority L2/L3, higher KB/prompt support caps. |

---

## Billing and review

- Define retainer vs time-and-materials for each tier.
- Quarterly review: scope, usage, and tier fit.
- Document who is billing owner and who approves change orders or new tiers.
