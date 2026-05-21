#!/usr/bin/env bash
# Production deploy on VPS (run from repo root after git pull).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> pnpm install"
pnpm install

echo "==> API Prisma generate + migrations"
pnpm db:generate
(cd apps/api && pnpm exec prisma migrate deploy)

echo "==> Voice DB Prisma generate + migrations"
pnpm db:voice:generate
pnpm db:voice:migrate:deploy

echo "==> Build monorepo"
pnpm build

echo "==> Done. Restart PM2, e.g.: pm2 restart voice-agent-api voice-agent-web --update-env"
