#!/usr/bin/env bash
# Emergency rollback — restore last known stable release folder (NOT latest git).
# Run on VPS as root:
#   bash scripts/vps-rollback-release.sh
# Or with explicit release:
#   BEST_STABLE_RELEASE=/var/www/voice-agent-releases/20260630-052417 bash scripts/vps-rollback-release.sh
set -euo pipefail

RELEASES_ROOT="${RELEASES_ROOT:-/var/www/voice-agent-releases}"
LIVE_LINK="${LIVE_LINK:-/var/www/voice-agent}"
BROKEN_RELEASE="${BROKEN_RELEASE:-20260630-161306}"
PREFERRED_STABLE="${PREFERRED_STABLE:-20260630-052417}"
FALLBACK_STABLE="${FALLBACK_STABLE:-20260625-041734}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8001/health}"

release_ok() {
  local dir="$1"
  [[ -d "$dir" ]] || return 1
  [[ -f "$dir/ecosystem.config.cjs" ]] || return 1
  [[ -d "$dir/services/twilio-voice-agent" ]] || return 1
  [[ -f "$dir/services/twilio-voice-agent/.env" ]] || return 1
  [[ -x "$dir/services/twilio-voice-agent/.venv/bin/uvicorn" ]] || return 1
  return 0
}

pick_stable_release() {
  if [[ -n "${BEST_STABLE_RELEASE:-}" ]] && release_ok "$BEST_STABLE_RELEASE"; then
    echo "$BEST_STABLE_RELEASE"
    return 0
  fi
  local candidate
  for candidate in \
    "$RELEASES_ROOT/$PREFERRED_STABLE" \
    "$RELEASES_ROOT/$FALLBACK_STABLE"; do
    if release_ok "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done
  local newest=""
  while IFS= read -r dir; do
    base="$(basename "$dir")"
    [[ "$base" == "$BROKEN_RELEASE" ]] && continue
    if release_ok "$dir"; then
      newest="$dir"
    fi
  done < <(find "$RELEASES_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
  [[ -n "$newest" ]] || return 1
  echo "$newest"
}

echo "==> STEP 1 — Scan releases in $RELEASES_ROOT"
ls -la "$RELEASES_ROOT" || { echo "ERROR: releases root missing" >&2; exit 1; }

BEST_STABLE_RELEASE="$(pick_stable_release)" || {
  echo "ERROR: No valid stable release found (need ecosystem.config.cjs, .env, .venv/uvicorn)" >&2
  exit 1
}

echo "==> Selected: $BEST_STABLE_RELEASE"
echo "    (excluded broken: $BROKEN_RELEASE)"

echo "==> STEP 2 — Switch production symlink"
ln -sfn "$BEST_STABLE_RELEASE" "$LIVE_LINK"
ls -la "$LIVE_LINK"

echo "==> STEP 3 — Restart PM2 cleanly"
pm2 delete all 2>/dev/null || true
cd "$LIVE_LINK"
pm2 start ecosystem.config.cjs
pm2 save

echo "==> STEP 4 — Verify system"
sleep 3
pm2 status
echo "--- health ---"
curl -sS "$HEALTH_URL" || true
echo

echo "==> STEP 5 — Runtime identity (release folder)"
cd "$LIVE_LINK/services/twilio-voice-agent"
.venv/bin/python -m app.scripts.runtime_identity_check || {
  echo "WARNING: runtime_identity_check failed — inspect pm2 logs" >&2
  pm2 logs twilio-voice-agent --lines 80 --nostream || true
  exit 1
}

echo "==> Rollback complete. LIVE=$LIVE_LINK -> $BEST_STABLE_RELEASE"
