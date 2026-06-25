#!/usr/bin/env bash
# Production deploy for twilio-voice-agent — run from repo root: bash scripts/vps-deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SERVICE_DIR="$ROOT/services/twilio-voice-agent"
BRANCH="${DEPLOY_GIT_BRANCH:-main}"

echo "==> VPS deploy starting in $ROOT"

if [[ ! -d .git ]]; then
  echo "ERROR: Not a git repository." >&2
  exit 1
fi

echo "==> git fetch + checkout origin/$BRANCH"
git fetch origin "$BRANCH"
git checkout -B "$BRANCH" FETCH_HEAD
git reset --hard FETCH_HEAD
echo "    branch=$(git rev-parse --abbrev-ref HEAD) commit=$(git rev-parse --short HEAD)"
git log -1 --oneline

echo "==> Python venv + dependencies"
cd "$SERVICE_DIR"
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
.venv/bin/pip install -r requirements.txt

echo "==> Tests"
if [[ "${DEPLOY_SKIP_TESTS:-}" == "1" ]]; then
  echo "    DEPLOY_SKIP_TESTS=1 — skipping pytest"
else
  .venv/bin/python -m pytest -q
fi

echo "==> Runtime identity"
cd "$SERVICE_DIR"
.venv/bin/python -m app.scripts.runtime_identity_check || {
  echo "ERROR: runtime_identity_check FAILED — do not take live calls." >&2
  exit 1
}

echo "==> Restart PM2 (if installed)"
cd "$ROOT"
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart twilio-voice-agent --update-env 2>/dev/null || {
    pm2 start ecosystem.config.cjs --update-env
  }
  pm2 save
else
  echo "    pm2 not found — start manually: pm2 start ecosystem.config.cjs"
fi

echo "==> Health check"
if command -v curl >/dev/null 2>&1; then
  curl -sf http://127.0.0.1:8001/health || echo "    Health check failed (is the service running?)"
fi

echo "==> Deploy complete."
