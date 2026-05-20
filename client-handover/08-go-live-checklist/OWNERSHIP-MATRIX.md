# Ownership matrix (RACI-style)

Clarifies who owns what after go-live. Adjust to your contract and roles.

---

## Client owns

- **Store content:** FAQs, branch profiles, policy text, promotions.
- **Policies and business rules:** What the agent may or may not say; escalation and callback rules.
- **Escalation team:** Who handles callbacks and live handoff; contact list and availability.
- **Prompt and voice content:** Final wording of prompts, greeting, fallback, escalation message (with support from delivery team as agreed).
- **Acceptance and go-live decision:** Sign-off on acceptance criteria and launch date.

---

## You / engineering own

- **Platform code:** Features, bugs, security, performance.
- **Deployments and infra:** Hosting, CI/CD, env, secrets, DB, backups.
- **Integrations:** Twilio, OpenAI, Shopify (code and config); webhook and token handling.
- **Security and compliance:** Tenant isolation, encryption, audit, access control.
- **Incident resolution (L3):** Runtime failures, webhooks, DB, deployment issues.

---

## Shared

- **Prompt quality:** Client provides content; delivery/ops can suggest and implement changes per SOP.
- **Rollout plan:** Agreed phased rollout and pilot; both parties follow checklist and runbooks.
- **Analytics review:** Regular review of KPIs and QA; client uses data for business decisions; delivery uses it for product and support improvements.
- **Roadmap priorities:** v2 features and order agreed together; delivery executes, client prioritizes and validates.

---

## Notes

- Document any exception (e.g. client manages hosting, or delivery manages L1 content updates) in the maintenance or SOW.
- Review ownership at least quarterly or when roles change.
