# VPS Deployment — Order Lookup Voice Agent

## Port map

| Service | Port |
|---------|------|
| order-lookup-voice-agent | **8001** |
| Redis | **6379** (optional; order agent uses in-memory cache) |

## Deploy

```bash
cd /var/www/voice-agent
git pull origin main

cd services/order-lookup-voice-agent
npm ci
npm run build
# Ensure .env exists with PUBLIC_BASE_URL, TWILIO_AUTH_TOKEN, OPENAI_API_KEY, SHOPIFY_*

cd ../..
sudo cp infra/nginx/voice-agent.mailcallcommunication.com.conf \
  /etc/nginx/sites-available/voice-agent.conf
sudo nginx -t && sudo systemctl reload nginx

pm2 delete all
pm2 start ecosystem.config.cjs
pm2 save
```

## Health check

```bash
curl -sS http://127.0.0.1:8001/health
```

## Twilio Console

| Setting | Value |
|---------|-------|
| Voice webhook | `https://agent.mailcallcommunication.com/voice/twilio/inbound` |
| Method | POST |

## Stop legacy agents

```bash
pm2 delete twilio-voice-agent voice-router 2>/dev/null || true
pm2 save
```

Only `order-lookup-voice-agent` should be online.
