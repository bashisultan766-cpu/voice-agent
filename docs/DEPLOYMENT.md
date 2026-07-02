# VPS Deployment — Twilio ConversationRelay Voice Agent

Deploy the Python service at `services/twilio-voice-agent` behind Nginx with PM2.

## Port map

| Service | Port | Notes |
|---------|------|-------|
| voice-router | **8000** | Twilio webhook `/voice/twilio/inbound` |
| twilio-voice-agent | **8001** | Main commerce agent |
| order-lookup-voice-agent | **8002** | Order status agent |
| Redis | **6379** | Session + caller memory + Shopify cache |

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
nano .env   # set PUBLIC_BASE_URL, Twilio, OpenAI, Shopify, Redis, Resend
```

Required in `.env`:

- `PUBLIC_BASE_URL=https://your-domain.com` (no trailing slash)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
- `OPENAI_API_KEY`
- `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`
- `REDIS_URL=redis://127.0.0.1:6379`
- `VALIDATE_TWILIO_SIGNATURES=true` (production)

## 3. PM2

From repo root:

```bash
cd services/voice-router && npm ci && npm run build
cd ../order-lookup-voice-agent && npm ci && npm run build
cd ../..
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs --lines 50
```

Verify locally:

```bash
curl -sS http://127.0.0.1:8000/health
curl -sS http://127.0.0.1:8001/health
curl -sS http://127.0.0.1:8002/health
```

## 4. Nginx

Copy the site config:

```bash
sudo cp infra/nginx/voice-agent.mailcallcommunication.com.conf \
  /etc/nginx/sites-available/voice-agent.conf
sudo ln -sf /etc/nginx/sites-available/voice-agent.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Routes (see `infra/nginx/voice-agent.mailcallcommunication.com.conf`):

- `POST /voice/twilio/inbound` → voice-router **8000** (Twilio webhook — unchanged URL)
- `POST /voice/twilio/routing/*` → voice-router **8000**
- `GET /voice/twilio/ws` → twilio-voice-agent **8001** (WebSocket)
- `POST /voice/twilio/agent/*` → twilio-voice-agent **8001** (internal)
- `/voice/order/*` → order-lookup **8002**

## 5. Twilio Console

| Setting | Value |
|---------|-------|
| A call comes in | Webhook |
| URL | `https://your-domain.com/voice/twilio/inbound` |
| HTTP | POST |

ConversationRelay WebSocket URL is derived from `PUBLIC_BASE_URL` automatically.

## 6. Deploy script

From repo root after `git pull`:

```bash
chmod +x scripts/vps-deploy.sh
./scripts/vps-deploy.sh
```

## 7. Smoke test

```bash
curl -sS https://your-domain.com/health
```

Place a test call to your Twilio number and confirm the agent responds.

## Local Redis (optional)

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```
