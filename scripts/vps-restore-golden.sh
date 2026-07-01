#!/usr/bin/env bash
# Restore the last known "very good" production agent (v4.56 / commit 6cd852dc).
#
# Use when rollback to 20260630-052417 still feels wrong — often the folder's
# .venv/.env was touched, or PM2 is still bound to another release cwd.
#
# Run on VPS as root:
#   bash scripts/vps-restore-golden.sh
#
# Force fresh rebuild from git (same code as 052417, new venv):
#   FORCE_REBUILD=1 bash scripts/vps-restore-golden.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/bashisultan766-cpu/voice-agent.git}"
BRANCH="${BRANCH:-fix/v425-payment-commerce-deploy}"
GOLDEN_COMMIT="${GOLDEN_COMMIT:-6cd852dc}"
RELEASES_ROOT="${RELEASES_ROOT:-/var/www/voice-agent-releases}"
LIVE_LINK="${LIVE_LINK:-/var/www/voice-agent}"
GOLDEN_FOLDER="${GOLDEN_FOLDER:-${RELEASES_ROOT}/20260630-052417}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8001/health}"
FORCE_REBUILD="${FORCE_REBUILD:-0}"
BACKUP_DIR="${RELEASES_ROOT}/.env-backups"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

pick_env_source() {
  local candidate
  for candidate in \
    "${GOLDEN_FOLDER}/services/twilio-voice-agent/.env" \
    "${LIVE_LINK}/services/twilio-voice-agent/.env" \
    "${RELEASES_ROOT}/20260625-041734/services/twilio-voice-agent/.env"; do
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

backup_env() {
  local src="$1"
  cp "$src" "${BACKUP_DIR}/golden-env-${TS}.env"
  echo "==> Backed up .env -> ${BACKUP_DIR}/golden-env-${TS}.env"
}

release_ok() {
  local dir="$1"
  [[ -d "$dir" ]] || return 1
  [[ -f "$dir/ecosystem.config.cjs" ]] || return 1
  [[ -f "$dir/services/twilio-voice-agent/.env" ]] || return 1
  [[ -x "$dir/services/twilio-voice-agent/.venv/bin/uvicorn" ]] || return 1
  return 0
}

verify_health() {
  local health_json
  health_json="$(curl -sf "$HEALTH_URL" 2>/dev/null || true)"
  [[ -n "$health_json" ]] || return 1
  echo "$health_json" | python3 -m json.tool
  echo "$health_json" | grep -q '"runtime_identity_ok": true' || return 1
  echo "$health_json" | grep -q '"voice_commerce_runtime"' || return 1
  return 0
}

pm2_clean_start() {
  local release="$1"
  pm2 delete all 2>/dev/null || true
  cd "$release"
  pm2 start ecosystem.config.cjs
  pm2 save
  sleep 5
}

print_pm2_cwd() {
  pm2 describe twilio-voice-agent 2>/dev/null | grep -E "status|restarts|exec cwd|script path" || pm2 status
}

switch_live() {
  local release="$1"
  ln -sfn "$release" "$LIVE_LINK"
  echo "==> live -> $(readlink -f "$LIVE_LINK")"
}

try_existing_golden() {
  if [[ "$FORCE_REBUILD" == "1" ]]; then
    return 1
  fi
  if ! release_ok "$GOLDEN_FOLDER"; then
    echo "==> Golden folder missing venv/.env: $GOLDEN_FOLDER"
    return 1
  fi
  echo "==> Trying existing golden folder: $GOLDEN_FOLDER"
  switch_live "$GOLDEN_FOLDER"
  pm2_clean_start "$LIVE_LINK"
  print_pm2_cwd
  verify_health
}

rebuild_golden() {
  local env_src new_release
  env_src="$(pick_env_source)" || {
    echo "ERROR: No .env found to restore. Set ENV_SOURCE=/path/to/.env" >&2
    exit 1
  }
  backup_env "$env_src"

  new_release="${RELEASES_ROOT}/golden-rebuild-${TS}"
  echo "==> Rebuilding golden release at $new_release (commit $GOLDEN_COMMIT)"
  git clone --depth 50 --branch "$BRANCH" "$REPO_URL" "$new_release"
  cd "$new_release"
  git checkout "$GOLDEN_COMMIT"
  echo "==> Git: $(git log -1 --oneline)"

  cp "$env_src" services/twilio-voice-agent/.env
  cd services/twilio-voice-agent
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
  .venv/bin/python -m app.scripts.runtime_identity_check

  switch_live "$new_release"
  pm2_clean_start "$LIVE_LINK"
  print_pm2_cwd
  verify_health
}

echo "==> VPS golden restore (v4.56 / $GOLDEN_COMMIT)"
echo "    FORCE_REBUILD=$FORCE_REBUILD"

if try_existing_golden; then
  echo "==> SUCCESS: restored existing $GOLDEN_FOLDER"
  exit 0
fi

echo "==> Existing golden not healthy — rebuilding from git..."
rebuild_golden
echo "==> SUCCESS: golden rebuild complete -> $(readlink -f "$LIVE_LINK")"
