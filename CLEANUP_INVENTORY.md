# Cleanup Inventory — Twilio Voice Agent Only

**Date:** 2026-06-22  
**Safety branch:** `cleanup/twilio-voice-agent-only-20260622-031802`  
**Pre-cleanup tests:** 142 passed (services/twilio-voice-agent)

## KEEP

| Path | Reason |
|------|--------|
| `services/twilio-voice-agent/` | Canonical runtime (FastAPI + ConversationRelay + OpenAI + Shopify + Resend + Redis) |
| `.git/` | Version control |
| `.gitignore` | Updated for Python-focused repo |
| `README.md` | Rewritten for new architecture |
| `ecosystem.config.cjs` | PM2 — twilio-voice-agent only |
| `infra/docker/docker-compose.yml` | Redis for local dev |
| `infra/nginx/voice-agent.mailcallcommunication.com.conf` | Updated for port 8001 voice routes |
| `docs/DEPLOYMENT.md` | New VPS deployment guide |
| `scripts/vps-deploy.sh` | Updated for twilio-voice-agent |
| `.github/workflows/ci.yml` | Updated to run Python tests |
| `.vscode/tasks.json` | Updated for pytest/uvicorn |

## DELETE

| Path | Reason |
|------|--------|
| `apps/api/` | Legacy NestJS multi-tenant API — not imported by twilio-voice-agent |
| `apps/web/` | Legacy Next.js dashboard — not used by new runtime |
| `backend/` | Old duplicate Python backend |
| `frontend/` | Old duplicate frontend |
| `services/voice-agent/` | Legacy Deepgram/ElevenLabs media-stream runtime |
| `packages/` | Monorepo packages (types, config, voice-db) — Node-only |
| `prisma/` | Root Prisma — belonged to apps/api |
| `node_modules/` | Monorepo Node dependencies |
| `infra/k8s/` | K8s manifests for old api/voice-worker |
| `infra/ecosystem.config.cjs` | Duplicate PM2 config for voice-api/voice-web |
| `infra/docker/docker-compose.prod.yml` | Legacy production compose |
| `examples/` | 3CX examples unrelated to ConversationRelay |
| `client-handover/` | Legacy multi-tenant SaaS handover docs |
| `voice-agent-clean/` | Empty placeholder directory |
| `data/` | Empty / unused |
| `.turbo/` | Turborepo cache |
| Root Node monorepo files | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `package-lock.json`, `.nvmrc`, `.prettierrc` |
| Root `docker-compose.yml` | Old Postgres-only compose (replaced by infra/docker Redis compose) |
| Legacy root docs | `SETUP-LOCAL.md`, `VOICE_AGENT_MODULE.md`, `EMAIL_DELIVERABILITY_CHECKLIST.md`, `*-changed-files-bundle.txt` |
| Legacy `docs/*` | Multi-tenant, ElevenLabs, Deepgram, NestJS deployment docs (34 files) |

## REVIEW (kept or removed with note)

| Path | Decision |
|------|----------|
| Root `.env.example` | Replaced with pointer to `services/twilio-voice-agent/.env.example` |
| `.claude/settings.local.json` | Kept (local IDE settings) |

## .env files found (NOT deleted individually — contained in removed legacy folders)

Report only — values not printed:

- `apps/api/.env`
- `apps/web/.env.local`
- `packages/voice-db/.env`

No `.env` in `services/twilio-voice-agent/` (uses `.env.example` template).

## Import scan (twilio-voice-agent → legacy code)

No imports from `apps/api`, `apps/web`, `backend`, `services/voice-agent`, `packages`, or `frontend`.

One comment-only match in `app/caller/models.py` ("DB backend") — not a code dependency.

## Post-cleanup status

- **Final tests:** 142 passed
- **compileall:** success
- **Health (port 8000):** ok=true, service=twilio-voice-agent, runtime=twilio_conversation_relay
- **Stub cleanup:** Stopped legacy `backend` and `services/voice-agent` Python processes that locked `.venv` binaries; directories fully removed
- **Legacy .env files:** Removed with parent folders (`apps/api/.env`, `apps/web/.env.local`, `packages/voice-db/.env`) — back up from git history or VPS if needed
