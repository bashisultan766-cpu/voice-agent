#!/usr/bin/env bash
# Safe forward deploy — new release folder + symlink + clean PM2 start.
# Run on VPS as root:
#   bash /var/www/voice-agent/scripts/vps-forward-release.sh
#
# Or one-liner after git clone exists:
#   BRANCH=fix/v425-payment-commerce-deploy bash scripts/vps-forward-release.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/bashisultan766-cpu/voice-agent.git}"
BRANCH="${BRANCH:-fix/v425-payment-commerce-deploy}"
RELEASES_ROOT="${RELEASES_ROOT:-/var/www/voice-agent-releases}"
LIVE_LINK="${LIVE_LINK:-/var/www/voice-agent}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8001/health}"
SKIP_TESTS="${DEPLOY_SKIP_TESTS:-1}"

# Copy .env from current live release, else known stable fallback.
if [[ -f "${LIVE_LINK}/services/twilio-voice-agent/.env" ]]; then
  ENV_SOURCE="${LIVE_LINK}/services/twilio-voice-agent/.env"
elif [[ -f "${RELEASES_ROOT}/20260630-052417/services/twilio-voice-agent/.env" ]]; then
  ENV_SOURCE="${RELEASES_ROOT}/20260630-052417/services/twilio-voice-agent/.env"
else
  echo "ERROR: No .env found. Set ENV_SOURCE=/path/to/.env" >&2
  exit 1
fi

NEW_RELEASE="${RELEASES_ROOT}/$(date +%Y%m%d-%H%M%S)"
echo "==> Creating release: $NEW_RELEASE"
echo "==> Branch: $BRANCH"
echo "==> .env from: $ENV_SOURCE"

git clone --depth 80 --branch "$BRANCH" "$REPO_URL" "$NEW_RELEASE"

cd "$NEW_RELEASE"
echo "==> Commit: $(git log -1 --oneline)"

cp "$ENV_SOURCE" services/twilio-voice-agent/.env

echo "==> Python venv + dependencies"
cd services/twilio-voice-agent
python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt

if [[ "$SKIP_TESTS" != "1" ]]; then
  echo "==> Running pytest"
  APP_ENV=test OPENAI_MODEL=gpt-4o .venv/bin/python -m pytest -q
else
  echo "==> Skipping pytest (DEPLOY_SKIP_TESTS=1)"
fi

echo "==> Runtime identity"
.venv/bin/python -m app.scripts.runtime_identity_check

echo "==> Switch live symlink"
ln -sfn "$NEW_RELEASE" "$LIVE_LINK"
echo "    live -> $(readlink -f "$LIVE_LINK")"

echo "==> PM2 clean start"
pm2 delete all 2>/dev/null || true
cd "$LIVE_LINK"
pm2 start ecosystem.config.cjs
pm2 save

echo "==> Waiting for health"
for i in 1 2 3 4 5 6; do
  sleep 2
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  echo "    attempt $i..."
done

echo "==> PM2 status"
pm2 status
pm2 describe twilio-voice-agent | grep -E "status|restarts|exec cwd|script path" || true

echo "==> Health"
if curl -sf "$HEALTH_URL" | python3 -m json.tool; then
  echo "==> DEPLOY OK: $NEW_RELEASE"
else
  echo "ERROR: Health check failed. Logs:" >&2
  pm2 logs twilio-voice-agent --err --lines 40 --nostream || true
  echo "Rollback: ln -sfn ${RELEASES_ROOT}/20260630-052417 ${LIVE_LINK} && pm2 delete all; cd ${LIVE_LINK} && pm2 start ecosystem.config.cjs && pm2 save" >&2
  exit 1
fi
