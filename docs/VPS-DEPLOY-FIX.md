# VPS deploy fix (voice-db schema)

## What was wrong

GitHub `main` had a broken `CallSession` model in `packages/voice-db/prisma/schema.prisma` (missing relation back to `CallLog`). The app only uses **`CallLog`** for the Next.js voice module.

This repo version removes `CallSession` and adds migration `20260521120000_drop_call_sessions` to drop `call_sessions` if it was created on the server.

## 1) Push from your PC

```powershell
cd "e:\Agents\shopify agent"
git add packages/voice-db/prisma/schema.prisma
git add packages/voice-db/prisma/migrations/20260521120000_drop_call_sessions/
git add packages/voice-db/package.json package.json apps/api/package.json apps/web/Dockerfile
git add docs/DEPLOYMENT.md docs/VPS-DEPLOY-FIX.md scripts/vps-deploy.sh
git commit -m "fix(voice-db): remove broken CallSession schema and fix VPS deploy"
git push origin main
```

## 2) Deploy on VPS

```bash
cd /var/www/voice-agent
git pull origin main

# Set real DB URL for voice DB (edit if not localhost/postgres)
export VOICE_AGENT_DATABASE_URL="postgresql://USER:PASS@localhost:5432/voice_agent"

chmod +x scripts/vps-deploy.sh
./scripts/vps-deploy.sh
# or: pnpm deploy:vps

pm2 delete voice-agent-api voice-agent-web 2>/dev/null || true
# start your ecosystem once (example):
# pm2 start ecosystem.config.js --update-env
pm2 save

curl -s http://127.0.0.1:3001/api/health
```

## 3) Verify voice-db client exists

```bash
ls packages/voice-db/generated/client/index.js
pnpm db:voice:generate
```

Expected: no `CallSession` in schema:

```bash
grep CallSession packages/voice-db/prisma/schema.prisma && echo BAD || echo OK
```
