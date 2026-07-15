#!/usr/bin/env bash
# Zero-downtime-ish deploy for Mail Call voice agent (keeps Bookstore running).
# Usage (from repo root on the VPS):
#   bash deploy.sh
# Optional:
#   DEPLOY_GIT_BRANCH=main bash deploy.sh
#   SKIP_GIT=1 bash deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

BRANCH="${DEPLOY_GIT_BRANCH:-main}"
MAILCALL_DIR="$ROOT/services/mailcall-voice-agent"
LOG_DIR="/logs/mailcall"
NGINX_SRC="$ROOT/infra/nginx/voice-agent.mailcallcommunication.com.conf"
NGINX_DST="${NGINX_SITE_PATH:-/etc/nginx/sites-available/voice-agent.conf}"
LOGROTATE_SRC="$ROOT/infra/logrotate/mailcall-voice-agent"
LOGROTATE_DST="/etc/logrotate.d/mailcall-voice-agent"

echo "==> Mail Call deploy starting in $ROOT"

if [[ ! -d "$MAILCALL_DIR" ]]; then
  echo "ERROR: missing $MAILCALL_DIR" >&2
  exit 1
fi

if [[ "${SKIP_GIT:-0}" != "1" ]]; then
  if [[ -d .git ]]; then
    echo "==> git fetch + pull --ff-only origin $BRANCH"
    git fetch origin "$BRANCH"
    git pull --ff-only origin "$BRANCH"
  else
    echo "WARN: not a git repo — skipping pull"
  fi
fi

echo "==> ensure log directory $LOG_DIR"
sudo mkdir -p "$LOG_DIR"
sudo chown "$(id -u):$(id -g)" "$LOG_DIR" 2>/dev/null || true

echo "==> build mailcall-voice-agent"
cd "$MAILCALL_DIR"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npm run build
cd "$ROOT"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "WARN: $ROOT/.env not found — MAILCALL_* must be present for PM2 env injection" >&2
fi

echo "==> PM2 start/reload mailcall-voice-agent (Bookstore left untouched)"
if ! command -v pm2 >/dev/null 2>&1; then
  echo "ERROR: pm2 not installed" >&2
  exit 1
fi

# Prefer ecosystem.config.js; fall back to .cjs
ECOSYSTEM="$ROOT/ecosystem.config.js"
[[ -f "$ECOSYSTEM" ]] || ECOSYSTEM="$ROOT/ecosystem.config.cjs"

if pm2 describe mailcall-voice-agent >/dev/null 2>&1; then
  pm2 reload "$ECOSYSTEM" --only mailcall-voice-agent --update-env
else
  pm2 start "$ECOSYSTEM" --only mailcall-voice-agent --update-env
fi
pm2 save

echo "==> Nginx site + test + reload"
if [[ -f "$NGINX_SRC" ]] && command -v nginx >/dev/null 2>&1; then
  sudo cp "$NGINX_SRC" "$NGINX_DST"
  if [[ -d /etc/nginx/sites-enabled ]]; then
    sudo ln -sfn "$NGINX_DST" /etc/nginx/sites-enabled/voice-agent.conf
  fi
  if [[ -f "$LOGROTATE_SRC" ]]; then
    sudo cp "$LOGROTATE_SRC" "$LOGROTATE_DST"
  fi
  sudo nginx -t
  sudo systemctl reload nginx
else
  echo "WARN: nginx not available or config missing — skipped reload"
fi

echo "==> health + port checks"
bash "$ROOT/scripts/mailcall-healthcheck.sh"

echo "==> Deploy complete."
echo "    Bookstore webhook:  https://<host>/conversationBrain/inbound"
echo "    Mail Call webhook:  https://<host>/api/voice/mailcall/inbound"
