#!/usr/bin/env bash
# Safe production deploy on VPS — run from repo root: bash scripts/vps-deploy.sh
# Pulls latest code from GitHub, installs deps, migrates DB, builds, restarts PM2.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EXPECTED_REMOTE_SUBSTR="${DEPLOY_GIT_REMOTE_MATCH:-github.com/bashisultan766-cpu/voice-agent}"
BRANCH="${DEPLOY_GIT_BRANCH:-main}"

echo "==> VPS deploy starting in $ROOT"

# --- Safety: must be a git checkout ---
if [[ ! -d .git ]]; then
  echo "ERROR: Not a git repository. Clone from GitHub instead of copying unknown files." >&2
  exit 1
fi

REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
if [[ -z "$REMOTE_URL" ]]; then
  echo "ERROR: No git remote 'origin' configured." >&2
  exit 1
fi
if [[ "$REMOTE_URL" != *"$EXPECTED_REMOTE_SUBSTR"* ]]; then
  echo "ERROR: Unexpected origin remote: $REMOTE_URL" >&2
  echo "       Expected URL to contain: $EXPECTED_REMOTE_SUBSTR" >&2
  exit 1
fi

# --- Safety: never pipe remote scripts into shell ---
if grep -rE 'curl[^|]*\|[^|]*\b(bash|sh)\b|wget[^|]*\|[^|]*\b(bash|sh)\b' scripts/ 2>/dev/null | grep -v '^#'; then
  echo "ERROR: Unsafe curl|bash pattern found in scripts/. Fix before deploy." >&2
  exit 1
fi

echo "==> git fetch + pull --ff-only origin $BRANCH"
git fetch origin "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "==> pnpm install (frozen lockfile)"
pnpm install --frozen-lockfile

echo "==> API Prisma generate + migrations"
pnpm db:generate
(cd apps/api && pnpm exec prisma migrate deploy)

echo "==> Voice DB Prisma generate + migrations"
pnpm db:voice:generate
pnpm db:voice:migrate:deploy

echo "==> Build monorepo"
pnpm build

echo "==> Restart PM2 (if installed)"
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart voice-api voice-web --update-env 2>/dev/null || {
    echo "    PM2 apps not running — start with: pm2 start ecosystem.config.cjs --update-env && pm2 save"
  }
else
  echo "    pm2 not found — skip restart"
fi

echo "==> Health check (optional)"
if command -v curl >/dev/null 2>&1; then
  API_CODE="$(curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/health 2>/dev/null || echo '000')"
  echo "    API /api/health => HTTP $API_CODE"
fi

echo "==> Deploy complete."
