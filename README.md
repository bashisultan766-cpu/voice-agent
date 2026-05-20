# Multi-tenant Shopify voice agents

Production-oriented monorepo: **Next.js** admin dashboard + **NestJS** API for AI voice agents tied to **Shopify** (product sync, search, checkout links, draft-order invoices) and **Twilio** inbound calls. Tenants manage multiple agents, operational dashboards, transcripts, leads, checkout links, and email events.

## What is included (core product)

- Multi-tenant auth (JWT), roles, encrypted agent secrets
- Agent CRUD, Shopify voice agent wizard, connection tests (live API where implemented)
- Shopify product sync, search, cart / draft-order checkout flows, checkout + email audit trail
- Twilio inbound webhooks, call sessions, tool orchestration, transcript storage, escalation hooks
- Ops dashboard: agents, calls, transcripts, leads, checkout links, email events, health
- Rate limits, Twilio signature validation, production env validation, dev ops endpoints gated in production

For third-party systems you must provision separately, see **[docs/EXTERNAL-DEPENDENCIES.md](docs/EXTERNAL-DEPENDENCIES.md)**.

## Core feature readiness

| Capability | Status | Notes |
|------------|--------|-------|
| Tenant auth + role isolation | Ready | JWT auth, tenant-scoped queries, production guardrails |
| Shopify catalog sync/search | Ready | Retry-aware sync, variant-aware search/details |
| Voice tool orchestration | Ready | Typed tool args, allowlisting, failure-safe summaries |
| Checkout link generation | Ready | Cart + draft-order modes, dedupe safeguards, metadata persistence |
| Payment email delivery | Ready | Branded HTML+text templates, idempotency, retries, send audit |
| Ops + observability basics | Ready | Call/tool/email/checkout records, webhook + audit logs |
| Local simulation/testing | Ready | Scripts for tool flow, sync, checkout, email (use real `DEV_*` IDs from your tenant) |

## Stack

| Layer | Technology |
|-------|------------|
| Monorepo | pnpm workspaces, Turborepo |
| Web | Next.js 15 (App Router), TypeScript, Tailwind |
| API | NestJS, Prisma, PostgreSQL |
| Optional | Redis (queues), Resend (email), Twilio, OpenAI, ElevenLabs, Shopify |

## Repository layout

```
├── apps/
│   ├── web/                 # Next.js dashboard
│   └── api/                 # NestJS + Prisma (primary app DB)
├── packages/
│   ├── types/               # Shared TypeScript types
│   ├── config/              # Shared config helpers
│   └── voice-db/            # Optional / legacy Prisma package (separate DB URL if used)
├── infra/docker/            # Local Postgres + Redis Compose
├── docs/                    # PRD, architecture, deployment, external deps
├── .env.example             # Monorepo env template
└── apps/api/.env.example    # API-focused template
```

## Prerequisites

- Node.js **20+**
- pnpm **9+**
- Docker (recommended for local Postgres + Redis)

## Local development

### 1. Install

```bash
pnpm install
```

### 2. Infrastructure

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

### 3. Environment

```bash
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

Edit values: at minimum `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, and web/API URLs. See comments in each `.env.example`.

### 4. Database

```bash
pnpm db:generate
pnpm db:migrate
```

### 5. Run

```bash
pnpm dev
```

- Dashboard: http://localhost:3000  
- API: http://localhost:3001  
- Health: http://localhost:3001/api/health  

### Local authentication

1. **Create your workspace**  
   Open **`/register`** in the dashboard. Choose a real organization name (this becomes your **workspace slug**), email, and password. That creates your tenant and **OWNER** account in the database.

2. **Sign in**  
   Use **workspace slug**, **email**, and **password** on **`/login`**. The app sets an **httpOnly** session cookie and mirrors the JWT in **`localStorage`** so API routes can forward a fresh `Authorization: Bearer` header when needed.

3. **Remove old / demo data**  
   To drop all rows and start over: `pnpm db:reset` (runs migrations again; you will need to register once more). Do not use this on production databases.

Keep **`JWT_SECRET` stable** across API restarts if you keep the same browser session; if you rotate it, sign in again.

### Quick bootstrap (API local dev/test)

Prisma generate, migrate, build, then a `simulate-tool` run (optional sanity check):

```bash
pnpm dev:bootstrap
```

Set **`DEV_TENANT_ID`** and **`DEV_AGENT_ID`** in `apps/api/.env` to IDs from **your** tenant (e.g. from Prisma Studio or the dashboard after you create a real agent), or the simulation step may exit early.

## Production deployment

Summary:

1. Build API and web; run `prisma migrate deploy` against production Postgres.
2. Configure env from `apps/api/.env.example` and `apps/web/.env.example` (never commit secrets).
3. Set `PUBLIC_WEBHOOK_BASE_URL`, Twilio webhooks, `CORS_ORIGIN`, `TRUST_PROXY` as appropriate.
4. Keep `ALLOW_HEADER_TENANT_FALLBACK=false` and leave `ENABLE_DEV_OPS_ENDPOINTS` unset/false unless staging explicitly needs dev HTTP tools.

Full steps: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## Post-deployment verification checklist

Use this after first deploy or any infra change.

- [ ] `GET /api/health` returns OK on the public API host.
- [ ] Dashboard loads, login works, tenant-scoped data does not leak across accounts (spot-check two users if applicable).
- [ ] `PUBLIC_WEBHOOK_BASE_URL` matches the URL Twilio calls; `TRUST_PROXY` correct behind load balancer.
- [ ] Place test call to Twilio number: call session appears in ops/calls; signature errors absent in logs when `VALIDATE_TWILIO_SIGNATURES=true`.
- [ ] Shopify: agent store URL + token saved; connection test succeeds; product sync returns data (or queue completes).
- [ ] Checkout path: tool flow creates `CheckoutLink`; URL is HTTPS and opens Shopify checkout.
- [ ] Email: `RESEND_API_KEY` + verified `RESEND_FROM_EMAIL`; test payment email delivers (staging only if prod inbox restricted).
- [ ] Production: `NODE_ENV=production`, strong `JWT_SECRET` / `ENCRYPTION_KEY`; users created only via your real registration flow.
- [ ] Production: `ENABLE_DEV_OPS_ENDPOINTS` not true unless intentionally staging; POST `/api/ops/...` dev routes return 403 when disabled.
- [ ] Backups: Postgres snapshot/restore documented and tested once.

## Root scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | All apps via Turborepo |
| `pnpm dev:local` | API + web with concurrent local runners |
| `pnpm build` / `lint` / `typecheck` | Monorepo-wide |
| `pnpm db:generate` | Prisma client (API app) |
| `pnpm db:migrate` | Migrations (dev workflow) |
| `pnpm db:studio` | Prisma Studio (API DB) |

## Security notes (high level)

- Twilio webhook signatures validated when enabled; require `TWILIO_AUTH_TOKEN` in production checks.
- Tenant header fallback is **development-only**; production boot fails if misconfigured (see `env-validation.ts`).
- Dev ops POST routes require **ADMIN**/**OWNER** JWT and are **forbidden in production** unless `ENABLE_DEV_OPS_ENDPOINTS=true`.
- Agent credentials stored encrypted (`ENCRYPTION_KEY`); do not log tokens or raw PII in application logs.

## Developer testing (non-production)

### 1) Prisma seed (no sample users)

`pnpm --filter api db:seed` runs a **no-op** seed (message only). Tenants, users, and agents come from **`/register`** and the dashboard, not from checked-in demo credentials.

For local scripts (`dev:simulate-tool`, `dev:simulate-voice-flow`, etc.), set real IDs in `apps/api/.env` after you create data in the UI (or via Prisma Studio):

- `DEV_TENANT_ID`
- `DEV_AGENT_ID`

Nest-backed local scripts run `nest build` first, then execute the compiled `dist/scripts/*.js` entrypoints. That keeps dependency injection metadata correct on all platforms (plain `tsx` on those files can break Nest wiring). For a faster loop after you already built once, run `pnpm --filter api build` once, then `node apps/api/dist/scripts/<name>.js` with the same env vars.

### 2) Simulate tools and voice flow locally (no live Twilio required)

Single-tool simulation:

```bash
pnpm --filter api dev:simulate-tool
# or from repo root:
pnpm dev:simulate-tool
```

Tool is controlled via env:
- `DEV_TOOL_NAME`
- `DEV_TOOL_ARGS`
- optional `DEV_CALL_SESSION_ID`

End-to-end local voice commerce flow (search -> details -> checkout -> optional email):

```bash
pnpm --filter api dev:simulate-voice-flow
# or from repo root:
pnpm dev:simulate-voice-flow
```

Flow controls:
- `DEV_FLOW_QUERY`
- `DEV_TEST_CUSTOMER_EMAIL`
- `DEV_TEST_CHECKOUT_MODE`
- `DEV_FLOW_SEND_EMAIL` (`false` to avoid actual send)

### 3) Manual Shopify catalog sync script

```bash
pnpm --filter api dev:sync-shopify
# or from repo root:
pnpm dev:sync-shopify
```

Requires a real Shopify connection for the selected agent.

### 4) Test checkout-link generation script

```bash
pnpm --filter api dev:test-checkout-link
# or from repo root:
pnpm dev:test-checkout-link
```

Inputs:
- `DEV_TEST_CUSTOMER_EMAIL`
- `DEV_TEST_CHECKOUT_MODE`
- `DEV_TEST_FORCE_NEW_CHECKOUT`
- `DEV_TEST_CHECKOUT_ITEMS` (JSON array, optional; auto-falls back to latest cached variant)

### 5) Test email send script / development route

Script:

```bash
pnpm --filter api dev:test-email-send
# or from repo root:
pnpm dev:test-email-send
```

Requires:
- `DEV_TEST_EMAIL_TO`
- optional `DEV_TEST_CHECKOUT_URL` (HTTPS)

Development HTTP route (for dashboard/manual API calls):
- `POST /api/ops/agents/:agentId/test-email`
- `POST /api/ops/agents/:agentId/simulate-tool`
- `POST /api/ops/agents/:agentId/sync-products`

Route guards:
- Require JWT with **ADMIN** or **OWNER**
- In production, blocked unless `ENABLE_DEV_OPS_ENDPOINTS=true` (staging-only switch)

Example simulate-tool call:

```bash
curl -X POST "http://localhost:3001/api/ops/agents/<agentId>/simulate-tool" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d "{\"toolName\":\"searchProducts\",\"args\":{\"query\":\"demo book\",\"limit\":5}}"
```

### 6) Manual ElevenLabs API key check

Use this to verify a key directly against ElevenLabs from your shell:

```bash
curl -i https://api.elevenlabs.io/v1/models -H "xi-api-key: YOUR_KEY"
```

## Documentation index

| Document | Content |
|----------|---------|
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Build, migrate, run, proxy, secrets |
| [docs/EXTERNAL-DEPENDENCIES.md](docs/EXTERNAL-DEPENDENCIES.md) | Twilio, Shopify, OpenAI, Resend, etc. |
| [docs/PRD-Multi-Tenant-AI-Voice-Agent-Platform.md](docs/PRD-Multi-Tenant-AI-Voice-Agent-Platform.md) | Product requirements |
| [docs/ARCHITECTURE-Multi-Tenant-AI-Voice-Platform.md](docs/ARCHITECTURE-Multi-Tenant-AI-Voice-Platform.md) | Technical architecture |
| [docs/ENV-CONFIG-Checklist-Step1.md](docs/ENV-CONFIG-Checklist-Step1.md) | Environment checklist |
| [docs/IMPLEMENTATION-MODULES.md](docs/IMPLEMENTATION-MODULES.md) | Module map |

## Known limitations (intentional)

- Web production build may require environment-specific tuning (memory/process policy) on some Windows developer machines; use Linux-based CI/build agents for release artifacts.
- Turbo monorepo runner reliability depends on host permissions; package-level scripts (`pnpm --filter ...`) remain the fallback path.
- Redis-backed queue workers are optional but recommended for high-volume sync/job workloads; without dedicated workers, throughput is lower.

## License / support

Private client delivery; refer to your commercial agreement for support and SLAs.
