# Acceptance criteria

Agree and sign off with the client before go-live. Use to avoid disputes and set clear “done” conditions.

---

## Product acceptance

| # | Criterion | Sign-off |
|---|-----------|----------|
| 1 | Admin can create, edit, and delete agents | ☐ |
| 2 | Admin can connect a Shopify store (OAuth or token) and connection is visible and stable | ☐ |
| 3 | Agent answers inbound call to the configured Twilio number | ☐ |
| 4 | Agent can provide product-related responses (when Shopify connected) | ☐ |
| 5 | Agent can provide order status (with order # and verification) when Shopify connected | ☐ |
| 6 | Agent can provide policy/FAQ/branch responses from the knowledge base | ☐ |
| 7 | Call transcripts are saved and visible in the dashboard | ☐ |
| 8 | Analytics (overview, by agent, by store, by tool) are visible and reflect recent calls | ☐ |
| 9 | Prompt versions are manageable (draft, publish) and live agent uses published version | ☐ |
| 10 | Fallback and escalation (handoff/callback) are available and function as designed | ☐ |
| 11 | System supports the agreed number of stores (e.g. current 7 stores) at go-live | ☐ |
| 12 | New store onboarding can be completed within the agreed time (e.g. under X hours with provided content) | ☐ |

---

## Operational acceptance

| # | Criterion | Sign-off |
|---|-----------|----------|
| 1 | Env and secrets configured per Technical Handover; no secrets in code or logs | ☐ |
| 2 | Twilio webhook and status callback URLs correct; signature validation on in production | ☐ |
| 3 | Health and ready endpoints return expected status | ☐ |
| 4 | Backup and rollback process documented and tested (or scheduled) | ☐ |
| 5 | Support levels (L1/L2/L3) and contacts documented | ☐ |

---

## Sign-off

| Role | Name | Date |
|------|------|------|
| Client / Product owner | | |
| Technical delivery | | |

**Notes:** _________________________________________________
