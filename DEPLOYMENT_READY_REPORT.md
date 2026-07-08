# Deployment Ready Report — Production Hardening v4.0

**Last updated:** 2026-07-08 (Sprint 3 — Mission Deployment)  
**Project root:** `E:\Agents\shopify agent`  
**Canonical TypeScript service:** `services/order-lookup-voice-agent`  
**Legacy Python service:** `services/twilio-voice-agent` (not started in PM2 production)

---

## Sprint 3 — order-lookup-voice-agent (Task 1: Production Reliability)

### Environment status (live probe `GET /health` @ port 8001)

| Field | Value | Notes |
|-------|-------|-------|
| `ok` | `true` | Service responding |
| `voiceProvider` | `OpenAI` | ElevenLabs circuit tripped at boot |
| `elevenLabsCircuitOpen` | `true` | `voiceFailoverReason: auth_failed` |
| `openAiFallbackVoice` | `onyx` | Fallback active |
| `postgresEventStoreEnabled` | `false` | `DATABASE_URL` not loaded by running process |
| `wsUrl` | `wss://agent.mailcallcommunication.com/conversationBrain/ws` | Production URL configured |
| `PUBLIC_BASE_URL` | `https://agent.mailcallcommunication.com` | In `.env` |

**Credential audit (names only, no values):**

| Variable | Status |
|----------|--------|
| `ELEVENLABS_API_KEY` | Placeholder — circuit breaker trips on boot |
| `VOICE_ID` | Placeholder |
| `DATABASE_URL` | Commented placeholder in `.env` — Postgres disabled |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Present — **live API returns HTTP 401** |
| `SKIP_SHOPIFY_STARTUP_CHECK` | `true` (required while Shopify token invalid) |

**Action required:** Restart service after injecting real `ELEVENLABS_API_KEY`, `VOICE_ID`, `DATABASE_URL`, and valid `SHOPIFY_ADMIN_ACCESS_TOKEN`. Remove `SKIP_SHOPIFY_STARTUP_CHECK` once Shopify ping passes.

### Task 1 — Regression test suite

```powershell
cd "E:\Agents\shopify agent\services\order-lookup-voice-agent"
npm test
```

| Suite | Result | Duration |
|-------|--------|----------|
| Full regression (`npm test`) | **447 / 447 passed** (66 files) | 82.15s |
| TypeScript build (`npm run build`) | **PASS** | — |

### Task 1 — Shopify order lookup flow (simulated + live)

**Automated flow tests (mocked Shopify + orchestrator):**

```powershell
npm test -- tests/conversationOrchestrator.test.ts tests/shopifyStorefrontAdapter.test.ts tests/order21796Timeline.test.ts tests/pipelineAcceptance.test.ts tests/circuitBreaker.test.ts tests/shopifyService.test.ts
```

| Result | Details |
|--------|---------|
| **62 / 62 passed** (6 files) | Greeting → order routing, timeline parsing, circuit breaker on THROTTLED, pipeline guards |

**Edge cases exercised in suite:**

- Shopify GraphQL THROTTLED → circuit opens, calls short-circuit
- Order not found / api_error mapping
- Orchestrator greeting routes to order lookup intent
- Order #21796 timeline fixture (refund/email fields)
- Tool execution blocked when slot validation not ready

**Live Shopify Admin API probe:**

```powershell
npx tsx scripts/audit_shopify_order_payload.ts "#21796"
```

| Result | Details |
|--------|---------|
| **FAIL — HTTP 401** | `Invalid API key or access token` against `sureshotbooks-com.myshopify.com` |

Live order lookup is **blocked until production Shopify token is valid**. Unit/orchestrator paths are green.

### Sprint 2 infrastructure delivered (this release)

- Unified ElevenLabs → OpenAI circuit breaker (`voiceAdapter.ts`, `ttsAdapter.ts`)
- `/health` exposes voice failover + Postgres status fields
- Postgres init awaited in `bootstrap()` before `startServer()`
- `runMigrations.ts` loads `.env` via `bootstrapEnv`
- PM2: `NODE_ENV=production`, `exp_backoff_restart_delay`
- `.gitignore` on service root (`.env`, `dist/`, `node_modules/`)

### Deployment readiness verdict (Sprint 3)

| Gate | Status |
|------|--------|
| Unit/integration tests | **READY** (447/447) |
| TypeScript compile | **READY** |
| Service health endpoint | **READY** (responding) |
| ElevenLabs primary voice | **NOT READY** (placeholder credentials) |
| Postgres event store | **NOT READY** (`DATABASE_URL` unset in active `.env`) |
| Shopify live order lookup | **NOT READY** (401 on Admin API) |
| PM2 crash restart | **READY** (`ecosystem.config.cjs`) |

### Validation commands (Phase 4)

```powershell
# Full regression
cd "E:\Agents\shopify agent\services\order-lookup-voice-agent"
npm test

# Health
Invoke-RestMethod -Uri http://localhost:8001/health | ConvertTo-Json -Depth 5

# Live Shopify order audit (after token fix)
npx tsx scripts/audit_shopify_order_payload.ts "#21796"

# Postgres migrations (after DATABASE_URL set)
npx tsx scripts/runMigrations.ts
```

### Recommended next sprint (CTO backlog)

1. **Watchdog logging** — structured JSON errors to CloudWatch/Datadog aggregator
2. **Caller memory hydration** — read `call_events` from Postgres on returning callers (cross-restart memory)
3. **Git feature branch** — commit Sprint 2/3 changes after credential validation (manual QA gate)

---

## Historical — v4.0 Python twilio-voice-agent (2026-06-22)

**Date:** 2026-06-22  
**Canonical service (legacy):** `services/twilio-voice-agent`  
**Safety branch:** `backup/pre-v4-cleanup`  
**Pre-cleanup inventory:** `pre_cleanup_inventory.txt`

---

## 1. Final Architecture

```
Twilio Phone Call
    → ConversationRelay STT/TTS (Twilio-managed)
    → POST /conversationBrain/inbound (TwiML)
    → WebSocket /conversationBrain/ws (plain-text JSON)
    → RealtimePipelineEngine (deterministic intent router, no LLM)
    → WorkerOrchestrator (13 async non-LLM workers)
    → MainLLMComposer (single OpenAI call — worker path only)
    → Fallback: run_agent_turn for conversational intents
    → Twilio TTS back to caller
```

**Supporting systems:** Redis (session + Shopify cache), Shopify Admin API, Resend email, optional PostgreSQL call logs.

**Production domain (nginx config):** `agent.mailcallcommunication.com`  
**Internal port:** `8001`

---

## 2. Files Kept

| Path | Purpose |
|------|---------|
| `services/twilio-voice-agent/` | Canonical v4.0 runtime (211 source files excl. `.venv`/`.env`) |
| `.git/` | Version control |
| `.gitignore` | **Repaired** — Python/env cache ignores |
| `.env.example` | **Sanitized** — pointer to service template (no real secrets) |
| `README.md` | Root architecture + quick start |
| `ecosystem.config.cjs` | PM2 config for production |
| `docs/DEPLOYMENT.md` | VPS deployment guide |
| `scripts/vps-deploy.sh` | Automated VPS pull/test/restart |
| `infra/nginx/voice-agent.mailcallcommunication.com.conf` | Nginx TLS + WebSocket proxy |
| `infra/docker/docker-compose.yml` | Local Redis |
| `.github/workflows/ci.yml` | CI: pytest + compileall on `services/twilio-voice-agent` |
| `.vscode/tasks.json` | Dev tasks |
| `CLEANUP_INVENTORY.md` | Prior cleanup documentation |
| `pre_cleanup_inventory.txt` | Root inventory snapshot (this audit) |
| `services/twilio-voice-agent/.env` | **Local only — not in git** |
| `services/twilio-voice-agent/.env.example` | Safe placeholders |
| `services/twilio-voice-agent/requirements.txt` | Python dependencies |
| `services/twilio-voice-agent/README.md` | Full v4.0 documentation |

---

## 3. Files Removed / Already Absent on Disk

Legacy directories **no longer present** on disk (git shows deletions pending commit):

- `apps/api/` — NestJS multi-tenant API
- `apps/web/` — Next.js dashboard
- `backend/`, `frontend/`
- `services/voice-agent/` — Deepgram/ElevenLabs legacy runtime
- `packages/`, root Node monorepo files (`package.json`, `turbo.json`, etc.)
- Legacy docs: `SETUP-LOCAL.md`, `VOICE_AGENT_MODULE.md`, `EMAIL_DELIVERABILITY_CHECKLIST.md`, bundles

**This audit additionally removed:**

- `__pycache__/`, `.pytest_cache/`, `.mypy_cache/` (outside `.venv`)
- `*.pyc` files (outside `.venv`)

**Not deleted (manual review if needed):**

- `.claude/` — local IDE settings
- `.vscode/` — editor config (kept)

---

## 4. Tests Result

| Phase | Result |
|-------|--------|
| Pre-cleanup | **526 passed** (25.26s) |
| Post-cleanup | **526 passed** (30.69s) |

---

## 5. Compile Result

| Phase | Result |
|-------|--------|
| Pre-cleanup | OK — no syntax errors |
| Post-cleanup | OK — no syntax errors |

---

## 6. Secret Scan Result

**Service `.env`:** exists locally, **not tracked/staged** by git ✓  
**Required variable names present in service `.env`:** all 11 required names verified (names only).

**Patterns scanned** in source/docs (excluding `.env`, `.venv`, `__pycache__`):

| Pattern | Findings |
|---------|----------|
| `OPENAI_API_KEY=` | `.env.example` files + test fixtures only (placeholders) |
| `SHOPIFY_ADMIN_ACCESS_TOKEN=` | `.env.example` + test fixtures |
| `TWILIO_AUTH_TOKEN=` | `.env.example` + test fixtures |
| `RESEND_API_KEY=` | `.env.example` only |
| `sk-`, `shpat_` | Test placeholders + README example format only |
| `xoxb-`, `-----BEGIN PRIVATE KEY-----` | **None** |

**CRITICAL FIX APPLIED:** Root `.env.example` contained **real credentials in comments**. Sanitized to placeholders during this audit. **If the old file was ever committed or pushed, rotate all affected credentials before production deploy.**

---

## 7. Suspicious File Scan Result

| Check | Result |
|-------|--------|
| Executables outside `.venv` (`.exe`, `.dll`, `.bat`, `.ps1`, etc.) | **None found** |
| Files > 5 MB outside `.git`/`.venv` | **None found** |
| Malware-like extensions (`.scr`, `.vbs`, `.jar`) | **None found** |
| `pip-audit` | **Not installed** (not run) |

---

## 8. Real Credentials Smoke Status (from prior verification)

Per user-provided verified status:

- OpenAI real credential works
- Shopify real credential works
- Twilio TwiML works
- Resend key/domain fixed to mailcallcommunication.com
- 526/526 tests passed
- No worker calls OpenAI (enforced by AST test in `test_composer.py`)
- No secrets printed in test runs

**Local health check during audit:** `http://127.0.0.1:8000/health` returned OK for `twilio-voice-agent` runtime. Port 8001 not running locally (production default).

---

## 9. Remaining External Actions

### Blockers before GitHub push

1. **`services/twilio-voice-agent/` is untracked** (0 git-tracked files, 211 untracked). Must `git add` and commit.
2. **~1200 pending git deletions/modifications** not yet committed — review and commit as a single cleanup changeset.
3. **Root `.env.example` secret exposure** — sanitized locally; verify git history and **rotate credentials** if old version was ever pushed.
4. **`.gitignore` was corrupted** — repaired; include in commit.

### Recommended before VPS deploy

1. Run `pip-audit` on VPS after `pip install` (optional but recommended).
2. Confirm `PUBLIC_BASE_URL=https://agent.mailcallcommunication.com` in service `.env`.
3. Set `VALIDATE_TWILIO_SIGNATURES=true` in production.
4. Ensure Redis running (`redis://127.0.0.1:6379`).
5. TLS certificate for `agent.mailcallcommunication.com` (Let's Encrypt per nginx config).

---

## 10. GitHub Push Commands (Windows PowerShell)

**Do not run until you review staged files and confirm no secrets.**

```powershell
cd "E:\Agents\shopify agent"

# Use full path if git is not on PATH
$git = "C:\Program Files\Git\cmd\git.exe"

# Review what will be committed
& $git status --short
& $git diff --stat

# Stage cleanup + v4.0 service (NEVER stage .env)
& $git add .gitignore .env.example README.md ecosystem.config.cjs
& $git add .github/ .vscode/ docs/ infra/ scripts/
& $git add services/twilio-voice-agent/
& $git add CLEANUP_INVENTORY.md DEPLOYMENT_READY_REPORT.md pre_cleanup_inventory.txt

# Stage deletions of legacy paths (review first!)
& $git add -u

# Verify .env is NOT staged
& $git status --short | Select-String "\.env$"
# Expected: no output (or only .env.example)

& $git diff --cached --name-only | Select-String "\.env$"
# Expected: only .env.example files, NOT services/.../.env

# Commit (adjust message as needed)
& $git commit -m "$( @'
Production Hardening v4.0: twilio-voice-agent only cleanup.

Remove legacy NestJS/Deepgram/ElevenLabs monorepo. Add canonical
ConversationRelay service with 13 workers, sanitized env templates,
deployment docs, and CI for Python pytest suite.
'@ )"

# Push when ready (explicit confirmation required)
& $git push -u origin HEAD
```

---

## 11. Hostinger VPS Deployment Commands (after GitHub push)

Run on VPS as deploy user (paths per `docs/DEPLOYMENT.md`):

```bash
# Initial clone (first time)
sudo mkdir -p /var/www/voice-agent
sudo chown $USER:$USER /var/www/voice-agent
cd /var/www/voice-agent
git clone https://github.com/YOUR_ORG/YOUR_REPO.git .

# Or update existing
cd /var/www/voice-agent
bash scripts/vps-deploy.sh

# Manual steps if PM2 not yet configured
cd /var/www/voice-agent/services/twilio-voice-agent
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
nano .env   # set production values — never commit

cd /var/www/voice-agent
pm2 start ecosystem.config.cjs
pm2 save

# Nginx
sudo cp infra/nginx/voice-agent.mailcallcommunication.com.conf \
  /etc/nginx/sites-available/voice-agent.conf
sudo ln -sf /etc/nginx/sites-available/voice-agent.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Verify
curl -sS https://agent.mailcallcommunication.com/health
```

---

## 12. Twilio Webhook Setup

| Setting | Value |
|---------|-------|
| A call comes in | Webhook |
| URL | `https://agent.mailcallcommunication.com/conversationBrain/inbound` |
| HTTP method | **POST** |
| ConversationRelay WebSocket | Derived from `PUBLIC_BASE_URL`: `wss://agent.mailcallcommunication.com/conversationBrain/ws` |

Set in service `.env`:

```
PUBLIC_BASE_URL=https://agent.mailcallcommunication.com
VALIDATE_TWILIO_SIGNATURES=true
```

---

## 13. Rollback Plan

1. **Git rollback on VPS:**
   ```bash
   cd /var/www/voice-agent
   git fetch origin
   git checkout backup/pre-v4-cleanup   # or previous known-good tag/commit
   bash scripts/vps-deploy.sh
   ```

2. **Local rollback:**
   ```powershell
   cd "E:\Agents\shopify agent"
   & "C:\Program Files\Git\cmd\git.exe" checkout backup/pre-v4-cleanup
   ```

3. **PM2 rollback:** `pm2 restart twilio-voice-agent` after checking out prior commit.

4. **Twilio:** Revert webhook URL in Twilio Console to previous endpoint if needed.

5. **Credentials:** If compromise suspected from old `.env.example`, rotate Twilio auth token, OpenAI key, Shopify token, and Resend key in Twilio/OpenAI/Shopify/Resend dashboards and update VPS `.env`.

---

## Final Recommendation

**Fix first, then deploy.**

- Code quality: **READY** (526/526 tests, compile clean, v4.0 architecture verified)
- Git/deployment hygiene: **NOT READY** until untracked service is committed, legacy deletions committed, and credential rotation confirmed if old `.env.example` was ever in git history

After completing section 10 commit/push and credential review, proceed with VPS deploy using section 11.
