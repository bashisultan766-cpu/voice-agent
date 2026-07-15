#!/usr/bin/env bash
# Zero-downtime-ish deploy for Mail Call voice agent (keeps Bookstore running).
# Usage (from repo root on the VPS):
#   bash deploy.sh
# Optional:
#   DEPLOY_GIT_BRANCH=production-ready bash deploy.sh
#   SKIP_GIT=1 bash deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

BRANCH="${DEPLOY_GIT_BRANCH:-production-ready}"
MAILCALL_DIR="$ROOT/services/mailcall-voice-agent"
MAILCALL_ENV_SERVICE="$MAILCALL_DIR/.env"
MAILCALL_ENV_ROOT="$ROOT/.env"
MAILCALL_ENV_EXAMPLE="$MAILCALL_DIR/.env.example"
LOG_DIR="/logs/mailcall"
NGINX_SRC="$ROOT/infra/nginx/voice-agent.mailcallcommunication.com.conf"
NGINX_DST="${NGINX_SITE_PATH:-/etc/nginx/sites-available/voice-agent.conf}"
LOGROTATE_SRC="$ROOT/infra/logrotate/mailcall-voice-agent"
LOGROTATE_DST="/etc/logrotate.d/mailcall-voice-agent"

REQUIRED_KEYS=(
  MAILCALL_TWILIO_PHONE_NUMBER
  MAILCALL_WP_URL
  MAILCALL_WP_USER
  MAILCALL_WP_APP_PASSWORD
)

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

ENV_FILE=""
if [[ -f "$MAILCALL_ENV_ROOT" ]]; then
  ENV_FILE="$MAILCALL_ENV_ROOT"
elif [[ -f "$MAILCALL_ENV_SERVICE" ]]; then
  ENV_FILE="$MAILCALL_ENV_SERVICE"
fi

if [[ -z "$ENV_FILE" ]]; then
  echo "ERROR: No .env found for Mail Call." >&2
  echo "  Create either:" >&2
  echo "    $MAILCALL_ENV_ROOT" >&2
  echo "    $MAILCALL_ENV_SERVICE" >&2
  echo "  Template:" >&2
  echo "    cp $MAILCALL_ENV_EXAMPLE $MAILCALL_ENV_SERVICE && nano $MAILCALL_ENV_SERVICE" >&2
  exit 1
fi

echo "==> using env file: $ENV_FILE"
MISSING=()
for key in "${REQUIRED_KEYS[@]}"; do
  line="$(grep -E "^${key}=" "$ENV_FILE" | head -n1 || true)"
  if [[ -z "$line" ]]; then
    MISSING+=("$key")
    continue
  fi
  val="${line#*=}"
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  # trim whitespace
  val="$(printf '%s' "$val" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [[ -z "$val" ]]; then
    MISSING+=("$key")
  fi
done

if [[ "${#MISSING[@]}" -gt 0 ]]; then
  echo "ERROR: $ENV_FILE is missing required MAILCALL_* values:" >&2
  printf '  - %s\n' "${MISSING[@]}" >&2
  echo "  See $MAILCALL_ENV_EXAMPLE" >&2
  exit 1
fi

echo "==> build mailcall-voice-agent"
cd "$MAILCALL_DIR"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npm run build

if [[ ! -f "$MAILCALL_DIR/dist/index.js" ]]; then
  echo "ERROR: build did not produce dist/index.js" >&2
  exit 1
fi
cd "$ROOT"

echo "==> PM2 start/reload mailcall-voice-agent (Bookstore left untouched)"
if ! command -v pm2 >/dev/null 2>&1; then
  echo "ERROR: pm2 not installed" >&2
  exit 1
fi

ECOSYSTEM="$ROOT/ecosystem.config.js"
[[ -f "$ECOSYSTEM" ]] || ECOSYSTEM="$ROOT/ecosystem.config.cjs"

# Clear prior crash-loop state, then start with fresh env
pm2 delete mailcall-voice-agent >/dev/null 2>&1 || true
pm2 start "$ECOSYSTEM" --only mailcall-voice-agent --update-env
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
sleep 1
bash "$ROOT/scripts/mailcall-healthcheck.sh"

echo "==> Deploy complete."
echo "    Bookstore webhook:  https://<host>/conversationBrain/inbound"
echo "    Mail Call webhook:  https://<host>/api/voice/mailcall/inbound"
