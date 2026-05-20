# Access inventory

Complete and keep updated. Use for handover and audit.

---

## Accounts and access

| System | Purpose | Owner | Billing | Notes |
|--------|---------|--------|---------|--------|
| Git repository | Code and releases | | | |
| API hosting | Backend deploy | | | e.g. Railway, Render |
| Web hosting | Dashboard deploy | | | e.g. Vercel |
| Domain / DNS | Webhook and app URL | | | |
| Twilio | Voice, numbers, webhooks | | | |
| Shopify | App / store connections | | | |
| OpenAI | API key, usage | | | |
| Database (Postgres) | Primary data | | | Backups: _____ |
| Redis (if used) | Cache / jobs | | | |
| S3/R2 (if used) | File storage | | | |
| Sentry | Errors | | | |
| PostHog | Product analytics | | | |

---

## Who is responsible for

| Role | Name / contact |
|------|----------------|
| Billing owner (platform/infra) | |
| Technical owner (deploy, incidents) | |
| Client product owner | |
| Support / L1 contact | |
| Who receives alerts | |

---

## Access handover checklist

- [ ] Git: read/write or read-only access granted as agreed.
- [ ] Hosting: deploy and env access granted; secrets documented in secure location.
- [ ] Twilio: account access or at least number and webhook config documented.
- [ ] Shopify: app credentials or store-level tokens; reconnect process documented.
- [ ] OpenAI: key and usage visibility; rotation process documented.
- [ ] Database: connection string and backup location; restore tested.
- [ ] Monitoring: Sentry/PostHog (or equivalent) access for technical owner.

---

## Revocation

Document how to revoke or rotate access (e.g. rotate API keys, remove users, disconnect Twilio/Shopify) in the incident or security runbook.
