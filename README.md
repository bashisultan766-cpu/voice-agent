# Twilio Shopify Voice Agent

AI phone sales agent for Shopify bookstores. Inbound calls hit **Twilio ConversationRelay** (managed STT/TTS); this service handles plain-text JSON over WebSocket, orchestrates **OpenAI**, calls **Shopify Admin API** tools, sends email via **Resend**, and stores caller memory in **Redis**.

## Architecture

```
Twilio phone call (+12512554549)
    → POST /voice/twilio/inbound
    → Order Lookup Voice Agent (Node, port 8001)
    → ConversationRelay + Eric voice
    → Shopify order lookup + streamed response
```

**Production service:** [`services/order-lookup-voice-agent/`](services/order-lookup-voice-agent/)

**Twilio webhook:** `POST /voice/twilio/inbound` (same URL as before)

| Endpoint | Purpose |
|----------|---------|
| `POST /voice/twilio/inbound` | Twilio voice webhook |
| `WS /voice/twilio/ws` | ConversationRelay WebSocket |
| `GET /health` | Health check |

The legacy Python commerce agent (`services/twilio-voice-agent/`) remains in the repo for reference but is **not** started in production PM2.

## Prerequisites

- Python **3.11+**
- Redis (recommended; in-memory fallback for single instance)
- Twilio account with a phone number
- OpenAI API key
- Shopify Admin API token
- Resend API key (for payment-link email tool)

## Environment variables

Copy the service template and fill in values:

```bash
cd services/twilio-voice-agent
cp .env.example .env
```

Key variables: `PUBLIC_BASE_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `OPENAI_API_KEY`, `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, `REDIS_URL`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`.

See [`services/twilio-voice-agent/README.md`](services/twilio-voice-agent/README.md) for the full list.

## Local development (Windows)

```powershell
cd "E:\Agents\shopify agent\services\twilio-voice-agent"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
# Edit .env — set PUBLIC_BASE_URL to your ngrok HTTPS URL
# Set VALIDATE_TWILIO_SIGNATURES=false for local ngrok testing

python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8001
```

Start Redis locally (optional):

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

### Twilio webhook URLs (local via ngrok)

```
Voice webhook:  https://<ngrok-id>.ngrok.io/voice/twilio/inbound  (POST)
WebSocket:      wss://<ngrok-id>.ngrok.io/voice/twilio/ws
```

Set `PUBLIC_BASE_URL=https://<ngrok-id>.ngrok.io` in `.env`.

## Linux VPS (production)

```bash
cd /var/www/voice-agent/services/twilio-voice-agent
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
# Edit .env with production secrets and PUBLIC_BASE_URL

cd /var/www/voice-agent
pm2 start ecosystem.config.cjs
pm2 save
```

Production paths in `ecosystem.config.cjs`:

- **cwd:** `services/twilio-voice-agent`
- **script:** `.venv/bin/uvicorn`
- **args:** `app.main:app --host 0.0.0.0 --port 8001 --workers 1`

Nginx should proxy `/voice/twilio/inbound`, `/voice/twilio/ws`, and `/health` to port **8001**. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### Twilio webhook URLs (production)

```
Voice webhook:  https://your-domain.com/voice/twilio/inbound  (POST)
WebSocket:      wss://your-domain.com/voice/twilio/ws
```

## Tests

```powershell
cd services/twilio-voice-agent
.\.venv\Scripts\Activate.ps1
python -m pytest -q
python -m compileall app
```

142 tests — all mocked, no live API calls required.

## Health check

```powershell
Invoke-RestMethod http://127.0.0.1:8001/health
```

Expected:

```json
{ "ok": true, "service": "twilio-voice-agent", "runtime": "twilio_conversation_relay" }
```

## Deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for VPS setup, Nginx, PM2, and Redis.

## License

Private client delivery.
