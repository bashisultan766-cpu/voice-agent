# SureShot Books — Voice Router

**Single Twilio webhook entrypoint** that routes inbound calls to the correct AI agent.

## Architecture

```
Twilio phone number
  → POST /voice-router/twilio/inbound   (port 8000)
  → <Gather> intent capture
  → POST /voice-router/decide (internal)
  → session lock (callSid → agent)
  → POST /voice-router/forward-to-agent
       ├─ order intent  → Node order agent :8002  (/voice/order/twilio/*)
       └─ general intent → Python main agent :8001 (/voice/twilio/*)
```

## Twilio configuration

Point your Twilio voice webhook **only** to:

```
POST https://<your-domain>/voice-router/twilio/inbound
```

Do **not** point Twilio directly at ports 8001 or 8002 in production.

## Local development (ngrok)

```powershell
# Terminal 1 — Python main agent
cd services/twilio-voice-agent
.\.venv\Scripts\Activate.ps1
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001

# Terminal 2 — Node order lookup
cd services/order-lookup-voice-agent
npm run dev   # port 8002

# Terminal 3 — Voice router (Twilio entrypoint)
cd services/voice-router
copy .env.example .env
npm run dev   # port 8000
```

Set `PUBLIC_BASE_URL` to your ngrok HTTPS URL in **all three** `.env` files.

Twilio webhook:

```
https://<ngrok-id>.ngrok.io/voice-router/twilio/inbound
```

Set `VALIDATE_TWILIO_SIGNATURES=false` on all services during local ngrok testing.

## Production (nginx + PM2)

```nginx
# Voice router — sole Twilio entry
location /voice-router/ {
    proxy_pass http://127.0.0.1:8000;
}

# Order lookup agent
location /voice/order/ {
    proxy_pass http://127.0.0.1:8002;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}

# Main Python commerce agent
location /voice/twilio/ {
    proxy_pass http://127.0.0.1:8001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

```bash
pm2 start ecosystem.config.cjs
```

## Shared secret

Set the same `VOICE_ROUTER_FORWARD_SECRET` in:

- `services/voice-router/.env`
- `services/order-lookup-voice-agent/.env`
- `services/twilio-voice-agent/.env`

The router adds `X-Voice-Router-Forward` when proxying to downstream agents so they accept internal forwards without Twilio signatures.

## Routing rules

| Caller says | Routes to |
|-------------|-----------|
| `456789` (5–12 digits) | Order lookup (8002) |
| "order", "tracking", "status", "refund" | Order lookup (8002) |
| General catalog / facility / payment | Main agent (8001) |
| Order service down | Main agent (8001) fallback |
| No speech detected | Re-prompt via `<Gather>` |

## API

`POST /voice-router/decide`

```json
{
  "speech": "where is my order 45678",
  "callSid": "CAxxxxxxxx",
  "from": "+15551234567"
}
```

Response:

```json
{
  "target": "order_lookup",
  "reason": "order_number_pattern",
  "confidence": "high",
  "forwardPath": "/voice/order/twilio/inbound"
}
```

## Tests

```powershell
cd services/voice-router
npm test
```
