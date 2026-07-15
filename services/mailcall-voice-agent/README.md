# Mail Call Communication Newspaper — Voice AI Agent

Isolated WordPress knowledge Voice AI service. **Structurally independent** from the SureShot / Shopify order-lookup agent — separate process, env prefix, and routes.

## Layout

```
services/mailcall-voice-agent/
  src/agents/mailcall/
    wordpress_api.ts   # WP REST client + TTL cache + Basic Auth
    router.ts          # /api/voice/mailcall webhooks + ConversationRelay WS
    prompts.ts         # Editorial Assistant system prompt framework
    conversation.ts    # Turn engine (retrieve → speak)
    textCleaner.ts     # HTML / shortcode / URL cleansing for TTS
    ttlCache.ts        # In-memory TTL + single-flight coalescing
  src/index.ts         # Express entry (port 8010 by default)
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/voice/mailcall/inbound` | Twilio Voice webhook → ConversationRelay TwiML |
| `WS` | `/api/voice/mailcall/ws` | ConversationRelay prompts / replies |
| `POST` | `/api/voice/mailcall/turn` | JSON turn harness (staging) |
| `GET` | `/api/voice/mailcall/health` | Agent health |
| `GET` | `/health` | Process health |

## Environment

Copy `.env.example` → `.env`. Required:

- `MAILCALL_TWILIO_PHONE_NUMBER`
- `MAILCALL_WP_URL`
- `MAILCALL_WP_USER`
- `MAILCALL_WP_APP_PASSWORD` (spaces allowed; stripped for Basic Auth)
- `MAILCALL_PUBLIC_BASE_URL` (for inbound TwiML WebSocket URL)

Optional: `MAILCALL_OPENAI_API_KEY` (retrieval-only speech if unset).

## Run (local)

```bash
cd services/mailcall-voice-agent
npm ci
npm test
npm run dev
```

## VPS deploy (alongside Bookstore)

From the repo root on the VPS (does **not** stop `order-lookup-voice-agent`):

```bash
# Put MAILCALL_* vars in the repo-root .env
bash deploy.sh
```

Artifacts:

| File | Purpose |
|------|---------|
| `ecosystem.config.js` | PM2 — both agents; Mail Call → `/logs/mailcall/`, 300M memory cap |
| `infra/nginx/nginx.mailcall.conf` | Mail Call proxy snippet (WS + headers) |
| `infra/nginx/voice-agent.mailcallcommunication.com.conf` | Full dual-agent site |
| `infra/logrotate/mailcall-voice-agent` | Daily rotation for `/logs/mailcall/*.log` |
| `scripts/mailcall-healthcheck.sh` | Port + `/health` checks for :8001 and :8010 |

Point the Mail Call Twilio number Voice webhook to:

```
https://<public-host>/api/voice/mailcall/inbound
```

## Design notes

- **Latency:** WordPress responses are cached (default 60s TTL) with request coalescing so concurrent turns do not stampede the REST API.
- **Resilience:** Timeouts / 5xx / network errors switch to a fixed polite fallback line — the call never crashes.
- **Voice:** Article HTML is cleansed and clipped to 2–3 spoken sentences before TTS.
