#!/usr/bin/env bash
# Safe upgrade: new release from GitHub + golden .env + symlink + PM2 clean start.
# Does NOT touch the golden release folder — instant rollback stays one command away.
#
# Examples on VPS:
#   # Stage 1 — voice only (v4.57):
#   TARGET_COMMIT=e786d6fd bash scripts/vps-safe-upgrade.sh
#
#   # Stage 2 — voice + product + stability (recommended before latest):
#   TARGET_COMMIT=33f59b56 bash scripts/vps-safe-upgrade.sh
#
#   # Stage 3 — full PC code including observability fix:
#   TARGET_COMMIT=30f00641 bash scripts/vps-safe-upgrade.sh
#
# Rollback after any failed test:
#   bash scripts/vps-rollback-release.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/bashisultan766-cpu/voice-agent.git}"
BRANCH="${BRANCH:-fix/v425-payment-commerce-deploy}"
TARGET_COMMIT="${TARGET_COMMIT:?Set TARGET_COMMIT (e.g. 33f59b56 or 30f00641)}"
RELEASES_ROOT="${RELEASES_ROOT:-/var/www/voice-agent-releases}"
LIVE_LINK="${LIVE_LINK:-/var/www/voice-agent}"
GOLDEN_FOLDER="${GOLDEN_FOLDER:-${RELEASES_ROOT}/20260630-052417}"
GOLDEN_MARKER="${RELEASES_ROOT}/.GOLDEN_RELEASE"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8001/health}"
TS="$(date +%Y%m%d-%H%M%S)"
NEW_RELEASE="${RELEASES_ROOT}/upgrade-${TS}"

if [[ -f "$GOLDEN_MARKER" ]]; then
  GOLDEN_FOLDER="$(cat "$GOLDEN_MARKER")"
fi

ENV_SOURCE="${ENV_SOURCE:-${GOLDEN_FOLDER}/services/twilio-voice-agent/.env}"
if [[ ! -f "$ENV_SOURCE" ]]; then
  echo "ERROR: No .env at $ENV_SOURCE" >&2
  exit 1
fi

mkdir -p "${RELEASES_ROOT}/.env-backups"
cp "$ENV_SOURCE" "${RELEASES_ROOT}/.env-backups/pre-upgrade-${TS}.env"
echo "$GOLDEN_FOLDER" > "$GOLDEN_MARKER"
echo "==> Golden rollback saved: $GOLDEN_FOLDER"
echo "==> Upgrade target commit: $TARGET_COMMIT"
echo "==> .env from: $ENV_SOURCE"

git clone --depth 120 --branch "$BRANCH" "$REPO_URL" "$NEW_RELEASE"
cd "$NEW_RELEASE"
git checkout "$TARGET_COMMIT"
echo "==> Deploying: $(git log -1 --oneline)"

cp "$ENV_SOURCE" services/twilio-voice-agent/.env
cd services/twilio-voice-agent
python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
.venv/bin/python -m app.scripts.runtime_identity_check

ln -sfn "$NEW_RELEASE" "$LIVE_LINK"
echo "==> live -> $(readlink -f "$LIVE_LINK")"

pm2 delete all 2>/dev/null || true
cd "$LIVE_LINK"
pm2 start ecosystem.config.cjs
pm2 save
sleep 6

pm2 describe twilio-voice-agent | grep -E "status|restarts|exec cwd|script path" || true
curl -sS "$HEALTH_URL" | python3 -m json.tool

echo ""
echo "==> UPGRADE LIVE: $NEW_RELEASE"
echo "==> TEST: place a call — test ORDER lookup first, then product/voice."
echo "==> ROLLBACK if bad:"
echo "    ln -sfn $GOLDEN_FOLDER $LIVE_LINK && pm2 delete all; cd $LIVE_LINK && pm2 start ecosystem.config.cjs && pm2 save"
