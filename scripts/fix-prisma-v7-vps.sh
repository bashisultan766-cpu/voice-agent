#!/usr/bin/env bash
# =============================================================================
# Prisma ORM v7 + monorepo rebuild for Ubuntu 24.04 VPS
#
# Usage (from repo root on VPS):
#   chmod +x scripts/fix-prisma-v7-vps.sh
#   bash scripts/fix-prisma-v7-vps.sh
#
# Prerequisites:
#   - Node.js 20.x (20.19+ recommended for Prisma 7)
#   - pnpm 9+ (corepack enable && corepack prepare pnpm@9.14.2 --activate)
#   - PM2 installed globally
#   - apps/api/.env with DATABASE_URL=postgresql://...
#   - apps/web/.env.local (NEXT_PUBLIC_* / API proxy vars for production)
#   - Optional: export VOICE_AGENT_DATABASE_URL before run (voice-db stays Prisma 6)
#
# What this script does:
#   1. Writes apps/api/prisma.config.ts (DATABASE_URL — not in schema.prisma)
#   2. Patches apps/api/prisma/schema.prisma (removes deprecated url line)
#   3. Cleans node_modules + build artifacts
#   4. Installs deps, upgrades Prisma 7 + @prisma/adapter-pg + pg + dotenv in apps/api
#   5. prisma validate / generate / migrate deploy (API)
#   6. Generates voice-db client (Prisma 6, separate schema)
#   7. Builds Nest API + Next.js web
#   8. Restarts PM2 (voice-agent-api, voice-agent-web)
#   9. Verifies health endpoints
#
# Verify manually after success:
#   curl -sS http://127.0.0.1:3001/api/health          # expect JSON status ok + database connected
#   curl -sS http://127.0.0.1:3001/api/health/ready    # expect 200
#   curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/   # expect 200 or 307
#   curl -sS http://127.0.0.1:3000/api/health        # web proxy to API health
#   pm2 status && pm2 logs voice-agent-api --lines 50 --nostream
#   pm2 logs voice-agent-web --lines 50 --nostream
#   # Browser (replace IP): http://YOUR_VPS_IP:3000  — dashboard loads, no "missing required error components"
#   # If browser fails but curl works: sudo ufw allow 3000/tcp && sudo ufw allow 3001/tcp
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

API_DIR="$REPO_ROOT/apps/api"
WEB_DIR="$REPO_ROOT/apps/web"
VOICE_DB_DIR="$REPO_ROOT/packages/voice-db"
PM2_API="voice-agent-api"
PM2_WEB="voice-agent-web"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

load_api_env() {
  set -a
  # shellcheck disable=SC1091
  source "$API_DIR/.env"
  set +a
  [[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL empty after sourcing $API_DIR/.env"
}

# --- 0. Preconditions (Ubuntu 24.04) ---
log "Checking Node.js (need v20+)"
command -v node >/dev/null || die "node not installed"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node 20+ required (found $(node -v))"

command -v pnpm >/dev/null || die "pnpm not installed (corepack enable && corepack prepare pnpm@9.14.2 --activate)"
command -v pm2 >/dev/null || die "pm2 not installed (npm i -g pm2)"

[[ -f "$API_DIR/.env" ]] || die "Missing $API_DIR/.env (DATABASE_URL required)"
grep -qE '^DATABASE_URL=' "$API_DIR/.env" || die "DATABASE_URL not set in $API_DIR/.env"

# --- 1. Stop PM2 (avoid file locks during install) ---
log "Stopping PM2 apps (ignore errors if not running)"
pm2 stop "$PM2_API" "$PM2_WEB" 2>/dev/null || true

# --- 2. Prisma v7 config: connection URL + migrations (not in schema.prisma) ---
log "Writing $API_DIR/prisma.config.ts"
cat > "$API_DIR/prisma.config.ts" <<'EOF'
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
EOF

# --- 3. Patch schema.prisma for Prisma 7 ---
log "Patching $API_DIR/prisma/schema.prisma"
SCHEMA="$API_DIR/prisma/schema.prisma"
cp -a "$SCHEMA" "$SCHEMA.bak.$(date +%Y%m%d%H%M%S)"

# Remove deprecated datasource URL fields (now in prisma.config.ts)
sed -i -E '/^[[:space:]]*url[[:space:]]*=/d' "$SCHEMA"
sed -i -E '/^[[:space:]]*directUrl[[:space:]]*=/d' "$SCHEMA"
sed -i -E '/^[[:space:]]*shadowDatabaseUrl[[:space:]]*=/d' "$SCHEMA"

# Use Rust-free client; keep generated output where @prisma/client resolves (pnpm api package)
if grep -q 'prisma-client-js' "$SCHEMA"; then
  sed -i 's/provider = "prisma-client-js"/provider = "prisma-client"/' "$SCHEMA"
fi
if ! grep -q 'output[[:space:]]*=' "$SCHEMA"; then
  sed -i '/provider = "prisma-client"/a\  output   = "../node_modules/.prisma/client"' "$SCHEMA"
fi

# --- 4. Ensure PrismaService uses driver adapter (required in Prisma 7) ---
PRISMA_SVC="$API_DIR/src/database/prisma.service.ts"
if ! grep -q '@prisma/adapter-pg' "$PRISMA_SVC" 2>/dev/null; then
  log "Patching $PRISMA_SVC for @prisma/adapter-pg"
  cat > "$PRISMA_SVC" <<'EOF'
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    const pool = new Pool({ connectionString });
    const adapter = new PrismaPg(pool);
    super({ adapter });
    this.pool = pool;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end();
  }
}
EOF
fi

# --- 5. Clean install artifacts ---
log "Cleaning node_modules and build outputs"
rm -rf node_modules
rm -rf "$API_DIR/node_modules" "$WEB_DIR/node_modules" "$VOICE_DB_DIR/node_modules"
rm -rf packages/types/node_modules packages/config/node_modules 2>/dev/null || true
rm -rf "$API_DIR/dist" "$WEB_DIR/.next"
rm -rf "$API_DIR/node_modules/.prisma" node_modules/.prisma 2>/dev/null || true
pnpm store prune 2>/dev/null || true

# --- 6. Install dependencies ---
log "pnpm install (monorepo root)"
corepack enable 2>/dev/null || true
pnpm install

# --- 7. Upgrade Prisma 7 + PostgreSQL driver adapter in apps/api ---
log "Installing Prisma 7 stack in apps/api"
pnpm --filter api add @prisma/client@7 @prisma/adapter-pg@7 dotenv@16 pg@8
pnpm --filter api add -D prisma@7 @types/pg@8

# --- 8. Generate Prisma clients ---
log "Validating and generating apps/api Prisma client"
cd "$API_DIR"
load_api_env
pnpm exec prisma validate
pnpm exec prisma generate
# Fail fast if client was not emitted (fixes: Cannot find module '.prisma/client/default')
test -f "$API_DIR/node_modules/.prisma/client/index.js" \
  || test -f "$API_DIR/node_modules/.prisma/client/default.js" \
  || die "Prisma client not generated under $API_DIR/node_modules/.prisma/client — check prisma generate output"
cd "$REPO_ROOT"

log "Generating packages/voice-db Prisma client (Prisma 6 — separate DB)"
export VOICE_AGENT_DATABASE_URL="${VOICE_AGENT_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/voice_agent}"
pnpm db:voice:generate || pnpm --filter @bookstore-voice-agents/voice-db run generate

# --- 9. Apply API migrations (production-safe) ---
log "Applying API migrations (prisma migrate deploy)"
cd "$API_DIR"
load_api_env
pnpm exec prisma migrate deploy
cd "$REPO_ROOT"

# --- 10. Build API and web ---
log "Building API (Nest)"
pnpm --filter api run build

log "Building web (Next.js)"
pnpm --filter web run build

# --- 11. Restart PM2 ---
log "Restarting PM2"
if pm2 describe "$PM2_API" >/dev/null 2>&1; then
  pm2 restart "$PM2_API" "$PM2_WEB" --update-env
else
  pm2 start "$REPO_ROOT/ecosystem.config.cjs" --update-env
fi
pm2 save

# --- 12. Verify API + frontend ---
log "Waiting for processes to listen"
sleep 8

API_HEALTH="$(curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/health 2>/dev/null || echo '000')"
API_READY="$(curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/health/ready 2>/dev/null || echo '000')"
WEB_ROOT="$(curl -sf -o /dev/null -w '%{http_code}' -L http://127.0.0.1:3000/ 2>/dev/null || echo '000')"
WEB_HEALTH="$(curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health 2>/dev/null || echo '000')"

echo "API GET /api/health       -> HTTP $API_HEALTH (expect 200)"
echo "API GET /api/health/ready -> HTTP $API_READY (expect 200)"
echo "Web GET /                 -> HTTP $WEB_ROOT (expect 200 or 307)"
echo "Web GET /api/health       -> HTTP $WEB_HEALTH (expect 200)"

VERIFY_OK=1
[[ "$API_HEALTH" == "200" ]] || VERIFY_OK=0
[[ "$API_READY" == "200" ]] || VERIFY_OK=0
[[ "$WEB_ROOT" == "200" || "$WEB_ROOT" == "307" || "$WEB_ROOT" == "308" ]] || VERIFY_OK=0

if [[ "$VERIFY_OK" -ne 1 ]]; then
  echo ""
  echo "Health check failed. Inspect logs:"
  echo "  pm2 logs $PM2_API --lines 80 --nostream"
  echo "  pm2 logs $PM2_WEB --lines 80 --nostream"
  pm2 logs "$PM2_API" --lines 40 --nostream 2>/dev/null || true
  pm2 logs "$PM2_WEB" --lines 40 --nostream 2>/dev/null || true
  exit 1
fi

log "SUCCESS — Prisma v7 active. Config: apps/api/prisma.config.ts"
echo ""
echo "Post-deploy checks:"
echo "  curl -sS http://127.0.0.1:3001/api/health | head -c 500; echo"
echo "  curl -sS -o /dev/null -w 'web home: %{http_code}\n' -L http://127.0.0.1:3000/"
echo "  pm2 status"
echo "  # Public URL (browser): http://YOUR_VPS_PUBLIC_IP:3000"
