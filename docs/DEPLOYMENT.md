# Deployment notes

Guidance for shipping **apps/api** (NestJS + Prisma) and **apps/web** (Next.js) to a client’s infrastructure. Adjust for your host (VPS, Kubernetes, PaaS).

## 1. Build-time requirements

- **Node.js 20+** and **pnpm 9+** on the build machine.
- Run from repo root:
  - `pnpm install`
  - `pnpm --filter api exec prisma generate` (or your root `db:generate` script)
  - `pnpm --filter api build`
  - `pnpm --filter web build`
- Ensure `DATABASE_URL` and other env vars needed at build time for Next.js are available if your Next config reads them (public vars use `NEXT_PUBLIC_*`).

## 2. Database

- Provision **PostgreSQL** (managed or self-hosted).
- Run migrations against the **production** database (never `migrate dev` in CI for prod; use `prisma migrate deploy`):

```bash
cd apps/api
pnpm exec prisma migrate deploy
```

- Keep backups and a restore drill documented for the client.

## 3. API (Nest)

- Start command (after build): from `apps/api`, `node dist/main.js` or `pnpm --filter api start`.
- Set **all** variables from `apps/api/.env.example` for production; see root `.env.example` for a consolidated list.
- Critical production flags:
  - `NODE_ENV=production`
  - `JWT_SECRET` (strong, unique)
  - `ENCRYPTION_KEY` (64 hex chars for AES-256-GCM secret storage)
  - `ALLOW_HEADER_TENANT_FALLBACK=false`
  - `PUBLIC_WEBHOOK_BASE_URL` = public HTTPS origin (no path suffix; routes include `/api/...`)
  - `VALIDATE_TWILIO_SIGNATURES=true` and `TWILIO_AUTH_TOKEN` set
  - `CORS_ORIGIN` = your Next.js origin(s), comma-separated
  - `TRUST_PROXY=true` when behind a reverse proxy
- **Dev ops HTTP routes** (`/api/ops/...` POST simulate-tool, sync-products, test-email): disabled in production unless `ENABLE_DEV_OPS_ENDPOINTS=true`. Leave unset/false for client delivery; enable only on staging if needed.
- Expose the API on a stable host/port; terminate TLS at the proxy or load balancer.

## 4. Web (Next.js)

- Set `NEXT_PUBLIC_API_URL` to the **browser-visible** API base (HTTPS).
- Set server-side API base for server actions / SSR (see `apps/web/.env.example`: `INTERNAL_API_URL` or equivalent if you split internal vs public URL).
- Start with `pnpm --filter web start` (or host-specific adapter).

## 5. Reverse proxy

- Route `/api/*` to the Nest app **or** split so Twilio/Shopify hit the API host directly (common: `api.customer.com` for API, `app.customer.com` for Next).
- Preserve `X-Forwarded-Proto` and `X-Forwarded-Host` for Twilio signature validation when `TRUST_PROXY=true`.

## 6. Secrets

- Never commit `.env` files.
- Prefer secret manager or host env injection in production.
- Rotate `JWT_SECRET`, `ENCRYPTION_KEY`, Twilio token, Shopify tokens, and API keys on compromise or offboarding.

## 7. Optional workers

- If product sync or jobs use **BullMQ** + Redis, run worker processes with the same `DATABASE_URL` / Redis config as documented in your ops runbook (confirm against current `apps/api` queue modules).

## 8. Seed data

- `pnpm --filter api db:seed` runs a **no-op** Prisma seed (log only). Tenants and users are created through **`/register`** in the admin app, not from the seed script.

## 9. Post-deployment verification checklist

Run this checklist immediately after each production deployment:

- [ ] `GET /api/health` returns HTTP 200 on the public API URL.
- [ ] Web app loads and authenticated users can access tenant-scoped data.
- [ ] `ALLOW_HEADER_TENANT_FALLBACK=false` in production env.
- [ ] Place a test call and confirm:
  - [ ] call session row created
  - [ ] transcript rows appear
  - [ ] no Twilio signature failures when validation is enabled
- [ ] Shopify for one production tenant:
  - [ ] connection status is OK
  - [ ] product sync succeeds (manual or queued)
  - [ ] search + product details resolve from cache
- [ ] Checkout flow:
  - [ ] checkout link created
  - [ ] URL opens hosted Shopify checkout
  - [ ] duplicate protection behaves as expected for same call/cart
- [ ] Email flow:
  - [ ] payment email event created
  - [ ] send status transitions to SENT
  - [ ] retry/dedupe behavior confirmed by sending the same request twice
- [ ] Audit / observability:
  - [ ] tool execution rows are recorded
  - [ ] webhook events are logged for expected tenant
  - [ ] no unhandled exception spikes in logs

## 10. Rollback notes (minimal)

- Keep the previous API and web build artifacts available for fast rollback.
- On schema changes, ensure forward/backward compatibility before deploy; if not possible, deploy API with feature flags disabled until migration completes.
- If rollback is required after migration:
  - restore DB snapshot taken pre-deploy
  - redeploy prior API + web versions
  - verify health and tenant-scoped access before reopening traffic
