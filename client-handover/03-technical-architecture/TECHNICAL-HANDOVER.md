# Technical handover — AI Voice Agents platform

This document is for technical owners and developers who will maintain, deploy, or extend the platform.

---

## 1. Architecture summary

- **Frontend:** Next.js (App Router), TypeScript, Tailwind; dashboard for stores, agents, knowledge, calls, analytics, QA.
- **Backend API:** NestJS, TypeScript, Prisma ORM; REST API; global prefix `/api`.
- **Database:** PostgreSQL (primary); Prisma schema and migrations.
- **Integrations:** Twilio (voice, webhooks), OpenAI (realtime API, optional vector stores), Shopify (Admin API when connected).
- **Deployment:** API and web can be deployed separately (e.g. API on Railway/Render, web on Vercel). Webhooks must be publicly reachable over HTTPS.

---

## 2. Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js, React, TypeScript, Tailwind |
| API | NestJS, Prisma, class-validator |
| DB | PostgreSQL |
| Voice | Twilio (inbound, status callbacks) |
| AI | OpenAI (realtime, chat + tools) |
| Optional | Redis (jobs/cache), S3/R2 (files), Sentry, PostHog |

---

## 3. Deployment

- **API:** Build with `pnpm run build` (or equivalent) in `apps/api`; run migrations before or after deploy per policy; set env vars (see Env and Integrations doc).
- **Web:** Build with `pnpm run build` in `apps/web`; set `NEXT_PUBLIC_API_URL` to the API base URL.
- **Webhooks:** Configure Twilio voice URL and status callback URL to point to the deployed API (e.g. `https://api.example.com/api/twilio/voice/inbound`). Ensure TLS and correct `PUBLIC_WEBHOOK_BASE_URL` for signature validation.
- **Migrations:** Prefer explicit migration steps (e.g. manual or CI step) over auto-migrate on boot in production. Test migrations on staging first.

---

## 4. Env variables

See **04-env-and-integrations** for the full list. Critical production vars include:

- `DATABASE_URL`, `NODE_ENV`, `PORT`
- `TWILIO_AUTH_TOKEN`, `PUBLIC_WEBHOOK_BASE_URL`, `VALIDATE_TWILIO_SIGNATURES`
- `OPENAI_API_KEY`
- `ENCRYPTION_KEY` (if storing encrypted tokens)
- `API_RATE_LIMIT_WINDOW_MS`, `API_RATE_LIMIT_MAX_REQUESTS`
- `TRUST_PROXY` (if behind a reverse proxy)

---

## 5. Secrets policy

- No secrets in code or in logs. Use env or a secrets manager in production.
- Shopify tokens: store encrypted at rest when EncryptionService is used; never return raw tokens in API responses.
- Rotate keys and tokens per security policy; document rotation in runbooks.

---

## 6. Backup policy

- Database: daily backups; PITR if available. Test restore periodically.
- Env and secrets: stored in a secure, documented location (e.g. Doppler, AWS Secrets Manager).
- Application and config: in version control; tagged releases for deploy and rollback.

---

## 7. Integrations

- **Twilio:** Inbound voice webhook + status callback; signature validation required in production; idempotent status handling.
- **OpenAI:** Realtime (or chat) + tools; rate limits and cost controlled by config and application limits.
- **Shopify:** OAuth or custom app token; required scopes documented; token encrypted when applicable.

---

## 8. Repo structure (high level)

- Monorepo (e.g. `apps/api`, `apps/web`, `packages/*`).
- API: `src/modules/` (calls, agents, analytics, knowledge, integrations, etc.), `src/common/`, `prisma/`.
- Docs: `docs/` (STEP7, STEP8, STEP9, tenant isolation, etc.); `client-handover/` for handover pack.

---

## 9. Health and monitoring

- **Health:** `GET /api/health` (status + DB + env); `GET /api/health/ready` (liveness).
- Use for load balancer and deployment smoke tests. Configure alerts on failure.
- Optional: Sentry for errors; PostHog for product analytics (admin usage, not voice content).

---

## 10. Rollback

- Application: redeploy previous image/release.
- Database: if a migration was applied, follow the rollback plan (reversible migration or restore from backup). Document in runbooks.
- Twilio/Shopify: revert webhook URL or disconnect store if needed to isolate issues.

For operational runbooks and incident response, see **06-support-runbooks**.
