# Deployment Ready Report — Production Hardening v4.0

**Date:** 2026-06-22  
**Project root:** `E:\Agents\shopify agent`  
**Canonical service:** `services/twilio-voice-agent`  
**Safety branch:** `backup/pre-v4-cleanup`  
**Pre-cleanup inventory:** `pre_cleanup_inventory.txt`

---

## 1. Final Architecture

```
Twilio Phone Call
    → ConversationRelay STT/TTS (Twilio-managed)
    → POST /voice/twilio/inbound (TwiML)
    → WebSocket /voice/twilio/ws (plain-text JSON)
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
| URL | `https://agent.mailcallcommunication.com/voice/twilio/inbound` |
| HTTP method | **POST** |
| ConversationRelay WebSocket | Derived from `PUBLIC_BASE_URL`: `wss://agent.mailcallcommunication.com/voice/twilio/ws` |

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
