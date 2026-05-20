# Step 9 — Production Hardening + Security + Rate Limits + Deployment

## 1. Implemented

### 1.1 Twilio webhook security
- **TwilioSignatureService**: Base64-safe comparison for `X-Twilio-Signature`; `VALIDATE_TWILIO_SIGNATURES` env (default true) to require validation; URL built from `PUBLIC_WEBHOOK_BASE_URL` + request path.
- **Controller**: Inbound and status routes validate signature when enabled; use `req.originalUrl` for path so proxy and query string are consistent.
- **Trust proxy**: `TRUST_PROXY=true` in main.ts for correct client IP and URL behind a reverse proxy.

### 1.2 Secrets and encryption
- **EncryptionService** (`common/encryption.service.ts`): AES-256-GCM; versioned payload `{ version, iv, tag, ciphertext }`; `encryptToStorage` / `decryptFromStorage` for DB-friendly string.
- **ENCRYPTION_KEY**: 32-byte hex. Use for Shopify tokens or other at-rest secrets.
- **env-validation**: `common/env-validation.ts` — `validateProductionEnv()` for required vars (e.g. DATABASE_URL, TWILIO_AUTH_TOKEN when validation on).

### 1.3 Tenant isolation
- **TenantGuard** (`common/guards/tenant.guard.ts`): Ensures `x-tenant-id` header and sets `req.tenantId`. Use on admin/API routes that must be tenant-scoped.
- **Audit rule**: Any API that takes an entity `id` from the client must scope by `tenantId` (e.g. `findFirst({ where: { id, tenantId } })`). Avoid `findUnique({ where: { id } })` for tenant data.

### 1.4 Rate limiting
- **ThrottlerModule**: Global throttle; `API_RATE_LIMIT_WINDOW_MS` (default 60000), `API_RATE_LIMIT_MAX_REQUESTS` (default 60) per IP.
- **Twilio controller**: `@SkipThrottle()` so webhooks are not rate-limited by IP.

### 1.5 Idempotency
- **Twilio status callback**: If session already has `endedAt` and terminal status (COMPLETED, FAILED, ABANDONED), skip processing to avoid duplicate events and outcome derivation.

### 1.6 Health
- **GET /api/health**: Database + env info.
- **GET /api/health/ready**: Liveness (DB only).

---

## 2. Env vars (Step 9)

```env
# Security
ENCRYPTION_KEY=<32-byte-hex>
TRUST_PROXY=true

# Twilio
TWILIO_AUTH_TOKEN=
PUBLIC_WEBHOOK_BASE_URL=
VALIDATE_TWILIO_SIGNATURES=true

# Rate limits
API_RATE_LIMIT_WINDOW_MS=60000
API_RATE_LIMIT_MAX_REQUESTS=60

# App
NODE_ENV=production
DATABASE_URL=
PORT=3001
```

---

## 3. Tenant isolation checklist

- [ ] Every admin/API query that uses an entity id from the request includes `tenantId` (from header or auth).
- [ ] No `findUnique({ where: { id } })` for tenant-scoped entities without also checking tenant.
- [ ] File/vector store keys include tenant (and store) prefix.
- [ ] Phone number attach and call logs are tenant-bound.
- [ ] QA and analytics endpoints use `x-tenant-id` (or auth) and filter by tenant.

---

## 4. Staging vs production

- Use separate **DATABASE_URL**, **TWILIO_AUTH_TOKEN**, **PUBLIC_WEBHOOK_BASE_URL**, and (if possible) Twilio numbers and Shopify stores.
- Staging: `VALIDATE_TWILIO_SIGNATURES=true` still recommended; use a separate Twilio project/token for staging.
- Production: Never log secrets; ensure **ENCRYPTION_KEY** is set if storing encrypted tokens.

---

## 5. CI/CD and rollback

- **CI**: Lint, typecheck, build, Prisma generate; optional unit/integration tests.
- **CD**: Deploy API (e.g. Railway/Render); run migrations with an approval gate; run smoke tests (e.g. GET /api/health, GET /api/health/ready).
- **Rollback**: Redeploy previous image; if migrations were run, follow rollback plan (e.g. reversible migrations or backup restore).

---

## 6. Backup and recovery

- **Database**: Daily backups; PITR if available.
- **Runbook**: Document how to restore DB, rotate secrets, and disable Twilio/Shopify in case of abuse.
- **Degraded mode**: If OpenAI/Shopify is down, voice can fall back to callback/KB-only behaviour; avoid corrupting state.

---

## 7. Definition of done (Step 9)

- [ ] Invalid Twilio webhook is rejected when validation is enabled.
- [ ] Tenant isolation audit done; sensitive queries use tenantId.
- [ ] Rate limits applied to API; webhooks excluded.
- [ ] Idempotent Twilio status handling.
- [ ] Staging and production envs separated.
- [ ] Health and ready endpoints in use.
- [ ] Backup and rollback plan documented.
