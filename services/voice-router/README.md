# SureShot Books — Voice Router

Routes inbound calls using the **original project Twilio webhook URL**.

## Architecture

```
Twilio phone number
  → POST /voice/twilio/inbound   (port 8000 — same URL as before)
  → <Gather> intent capture
  → POST /voice/twilio/routing/gather
  → POST /voice/twilio/routing/forward-to-agent
       ├─ order intent  → Node order agent :8002
       └─ general intent → Python main agent :8001 (/voice/twilio/agent/inbound)
```

## Twilio configuration

**Keep your existing webhook — do not change it:**

```
POST https://<your-domain>/voice/twilio/inbound
```

## Local development (ngrok)

```powershell
# Terminal 1 — Python main agent
cd services/twilio-voice-agent
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001

# Terminal 2 — Node order lookup
cd services/order-lookup-voice-agent
npm run dev

# Terminal 3 — Voice router
cd services/voice-router
npm run dev
```

Twilio webhook (unchanged):

```
https://<ngrok-id>.ngrok.io/voice/twilio/inbound
```

## Production nginx

See [`infra/nginx/voice-agent.mailcallcommunication.com.conf`](../../infra/nginx/voice-agent.mailcallcommunication.com.conf).

Key routes:

- `= /voice/twilio/inbound` → voice-router :8000
- `/voice/twilio/routing/` → voice-router :8000
- `/voice/twilio/ws` → Python :8001
- `/voice/twilio/agent/` → Python :8001
- `/voice/order/` → order lookup :8002

## Shared secret

Set the same `VOICE_ROUTER_FORWARD_SECRET` in all three `.env` files.

## API

`POST /voice/twilio/routing/decide` — internal routing decision API.

## Tests

```powershell
cd services/voice-router
npm test
```
