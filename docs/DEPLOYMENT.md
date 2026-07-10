# VPS Deployment — Order Lookup Voice Agent

## Port map

| Service | Port |
|---------|------|
| order-lookup-voice-agent | **8001** |
| Postgres | **5432** (session L2 persistence via `DATABASE_URL`) |

## Deploy

```bash
cd /var/www/voice-agent
git pull origin production-ready

cd services/order-lookup-voice-agent
npm ci
npm run build
npx tsx scripts/runMigrations.ts   # requires DATABASE_URL in service .env

cd /var/www/voice-agent
pm2 restart order-lookup-voice-agent --update-env
# First boot:
# pm2 start ecosystem.config.cjs && pm2 save

curl -sS http://127.0.0.1:8001/health
```

Nginx should proxy `/conversationBrain/inbound`, `/conversationBrain/ws`, and `/health` to port **8001**.

## Environment

Ensure `/var/www/voice-agent/services/order-lookup-voice-agent/.env` includes:

- `PUBLIC_BASE_URL` (HTTPS origin Twilio reaches, no trailing slash)
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`
- `OPENAI_API_KEY`
- `SHOPIFY_SHOP_DOMAIN` / `SHOPIFY_ADMIN_ACCESS_TOKEN`
- `DATABASE_URL` (Postgres)
- `VOICE_ID` (ElevenLabs voice id for ConversationRelay)
- `RESEND_API_KEY` / `RESEND_FROM_EMAIL` (optional but required for checkout email)

**Critical:** `VOICE_ID` must be your ElevenLabs voice ID (not the display name `Eric`).

## Debug "application error"

```bash
pm2 logs order-lookup-voice-agent --lines 100

curl -sS -X POST http://127.0.0.1:8001/conversationBrain/inbound \
  -d "CallSid=CAtest&From=%2B15551234567&To=%2B12512554549"

curl -sS https://agent.mailcallcommunication.com/health
```

If logs show `Invalid Twilio signature`, confirm `PUBLIC_BASE_URL` matches the Twilio webhook host exactly.

## Twilio Console

| Setting | Value |
|---------|-------|
| Voice webhook | `https://agent.mailcallcommunication.com/conversationBrain/inbound` |
| Method | POST |

## Production process

Only `order-lookup-voice-agent` should be online in PM2 (`ecosystem.config.cjs`).
