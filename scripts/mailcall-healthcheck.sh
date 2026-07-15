#!/usr/bin/env bash
# Confirm both voice agents are listening and healthy.
set -euo pipefail

BOOKSTORE_PORT="${BOOKSTORE_PORT:-8001}"
MAILCALL_PORT="${MAILCALL_PORT:-8010}"
FAIL=0

echo "==> listening ports"
if command -v ss >/dev/null 2>&1; then
  ss -lntp | grep -E ":${BOOKSTORE_PORT}|:${MAILCALL_PORT}" || true
elif command -v netstat >/dev/null 2>&1; then
  netstat -lntp 2>/dev/null | grep -E ":${BOOKSTORE_PORT}|:${MAILCALL_PORT}" || true
else
  echo "    (ss/netstat not available)"
fi

check_http() {
  local name="$1" url="$2"
  if curl -sf --max-time 5 "$url" >/dev/null; then
    echo "OK  $name  $url"
  else
    echo "FAIL $name  $url" >&2
    FAIL=1
  fi
}

echo "==> HTTP health"
check_http "bookstore" "http://127.0.0.1:${BOOKSTORE_PORT}/health"
check_http "mailcall"  "http://127.0.0.1:${MAILCALL_PORT}/api/voice/mailcall/health"
check_http "mailcall-root" "http://127.0.0.1:${MAILCALL_PORT}/health"

if command -v pm2 >/dev/null 2>&1; then
  echo "==> PM2 status"
  pm2 list | grep -E "order-lookup-voice-agent|mailcall-voice-agent" || true
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "Health check finished with failures." >&2
  exit 1
fi

echo "All local health checks passed."
