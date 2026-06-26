# VPS Deployment — Twilio ConversationRelay Voice Agent

Deploy the Python service at `services/twilio-voice-agent` behind Nginx with PM2.

## Port map

| Service | Port | Notes |
|---------|------|-------|
| twilio-voice-agent | **8001** | FastAPI + uvicorn (`--workers 1`) |
| Redis | **6379** | Session + caller memory + Shopify cache |
| Postgres | **5432** | Optional — workflow replay + analytics |

## 1. Server prerequisites

```bash
sudo apt update && sudo apt install -y python3 python3-venv python3-pip nginx redis-server
sudo systemctl enable redis-server
```

## 2. Clone and configure

```bash
cd /var/www/voice-agent
git pull origin main

cd services/twilio-voice-agent
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
nano .env   # see checklist below
```

### Environment variable checklist (production)

```env
APP_ENV=production
DEBUG=false
PUBLIC_BASE_URL=https://your-domain.com
REDIS_URL=redis://127.0.0.1:6379
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
VALIDATE_TWILIO_SIGNATURES=true
WS_TOKEN_VALIDATION_ENABLED=true
OPENAI_API_KEY=...
SHOPIFY_SHOP_DOMAIN=...
SHOPIFY_ADMIN_ACCESS_TOKEN=...
RESEND_API_KEY=...
RESEND_FROM_EMAIL=...
SUPPORT_EMAIL=...
VOICE_ORCHESTRATOR_ENABLED=true
VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED=true
ENABLE_ADMIN_DEBUG_ENDPOINTS=false
ENABLE_API_DOCS=false
```

Full audit: [`docs/PRODUCTION_CONFIG_AUDIT.md`](../PRODUCTION_CONFIG_AUDIT.md)

## 3. Pre-deploy gate

```bash
cd services/twilio-voice-agent
APP_ENV=production python scripts/pre_deploy_health_gate.py
python scripts/staging_smoke_tests.py
```

## 4. PM2

From repo root:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 install pm2-logrotate   # optional, recommended
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
```

### Graceful reload

```bash
pm2 reload twilio-voice-agent --update-env
```

Active WebSocket calls may complete on the old process; new calls use the new code.

### Rollback

```bash
git checkout <previous-stable-tag>
cd services/twilio-voice-agent && .venv/bin/pip install -r requirements.txt
pm2 reload twilio-voice-agent --update-env
curl -sS http://127.0.0.1:8001/health
```

See [`docs/CANARY_ROLLBACK_RUNBOOK.md`](../CANARY_ROLLBACK_RUNBOOK.md).

Verify locally:

```bash
curl -sS http://127.0.0.1:8001/health
```

## 5. Nginx

Copy the site config:

```bash
sudo cp infra/nginx/voice-agent.mailcallcommunication.com.conf \
  /etc/nginx/sites-available/voice-agent.conf
sudo ln -sf /etc/nginx/sites-available/voice-agent.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Routes proxied to port 8001:

- `POST /voice/twilio/inbound`
- `GET /voice/twilio/ws` (WebSocket upgrade, 3600s timeout)
- `GET /health` (10s read timeout)

**Multi-instance:** enable `ip_hash` on upstream for WebSocket sticky sessions — see [`docs/MULTI_WORKER_SAFETY_AUDIT.md`](../MULTI_WORKER_SAFETY_AUDIT.md).

## 6. Twilio Console

| Setting | Value |
|---------|-------|
| A call comes in | Webhook |
| URL | `https://your-domain.com/voice/twilio/inbound` |
| HTTP | POST |

ConversationRelay WebSocket URL is derived from `PUBLIC_BASE_URL` automatically.

## 7. Deploy script

From repo root after `git pull`:

```bash
chmod +x scripts/vps-deploy.sh
./scripts/vps-deploy.sh
```

## 8. Smoke test

```bash
curl -sS https://your-domain.com/health
cd services/twilio-voice-agent && python scripts/staging_smoke_tests.py
```

Place a test call to your Twilio number and confirm the agent responds.

## Local Redis (optional)

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

## Scaling note

Keep **one PM2 instance** and **uvicorn `--workers 1`** unless you implement sticky WebSocket sessions and accept per-process circuit breaker state.
