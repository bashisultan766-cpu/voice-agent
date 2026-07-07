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

## Copy env from old Python agent

```bash
OLD=/var/www/voice-agent/services/twilio-voice-agent/.env
NEW=/var/www/voice-agent/services/order-lookup-voice-agent/.env

for KEY in PUBLIC_BASE_URL TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN OPENAI_API_KEY OPENAI_MODEL \
  SHOPIFY_SHOP_DOMAIN SHOPIFY_ADMIN_ACCESS_TOKEN SHOPIFY_API_VERSION \
  VOICE_ID VOICE_MODEL VOICE_LANGUAGE VOICE_TTS_PROVIDER ELEVENLABS_API_KEY \
  VALIDATE_TWILIO_SIGNATURES; do
  VAL=$(grep -E "^${KEY}=" "$OLD" 2>/dev/null | cut -d= -f2-)
  if [ -n "$VAL" ]; then
    if grep -q "^${KEY}=" "$NEW" 2>/dev/null; then
      sed -i "s|^${KEY}=.*|${KEY}=${VAL}|" "$NEW"
    else
      echo "${KEY}=${VAL}" >> "$NEW"
    fi
  fi
done

grep -q "^PORT=" "$NEW" || echo "PORT=8001" >> "$NEW"
```

**Critical:** `VOICE_ID` must be your ElevenLabs voice ID (not `Eric`). `PUBLIC_BASE_URL` must be `https://agent.mailcallcommunication.com` (no trailing slash).

## Debug "application error"

```bash
# After deploy, watch logs while placing a test call
pm2 logs order-lookup-voice-agent --lines 100

# Simulate inbound (signature will fail without real Twilio sig — check logs for url=)
curl -sS -X POST http://127.0.0.1:8001/conversationBrain/inbound \
  -d "CallSid=CAtest&From=%2B15551234567&To=%2B12512554549"

# Public health
curl -sS https://agent.mailcallcommunication.com/health
```

If logs show `Invalid Twilio signature`, confirm `PUBLIC_BASE_URL` matches the Twilio webhook host exactly.

```bash
curl -sS http://127.0.0.1:8001/health
```

## Twilio Console

| Setting | Value |
|---------|-------|
| Voice webhook | `https://agent.mailcallcommunication.com/conversationBrain/inbound` |
| Method | POST |

## Stop legacy agents

```bash
pm2 delete twilio-voice-agent voice-router 2>/dev/null || true
pm2 save
```

Only `order-lookup-voice-agent` should be online.
