# SureShot Books — Order Lookup Voice Agent

**Production voice agent** for Twilio number order-status calls.

## Twilio webhook (unchanged URL)

```
POST https://your-domain.com/voice/twilio/inbound
WebSocket: wss://your-domain.com/voice/twilio/ws
```

## Flow

```
Caller dials Twilio number
  → POST /voice/twilio/inbound
  → ConversationRelay (Eric / ElevenLabs)
  → WebSocket /voice/twilio/ws
  → Order number → Shopify lookup → streamed voice response
```

## VPS setup

```bash
cd /var/www/voice-agent
git pull origin main
cd services/order-lookup-voice-agent
cp .env.example .env   # edit with real secrets
npm ci && npm run build
cd ../..
sudo cp infra/nginx/voice-agent.mailcallcommunication.com.conf /etc/nginx/sites-available/voice-agent.conf
sudo nginx -t && sudo systemctl reload nginx
pm2 delete all
pm2 start ecosystem.config.cjs
pm2 save
curl -s http://127.0.0.1:8001/health
```

## Required .env

- `PUBLIC_BASE_URL` — your HTTPS domain
- `TWILIO_AUTH_TOKEN` — same as Twilio Console
- `OPENAI_API_KEY`
- `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`
- `ELEVENLABS_VOICE_ID=Eric` (via Twilio ConversationRelay)

## Tests

```bash
npm test
```
