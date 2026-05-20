# Twilio live inbound voice (production)

Use this when routing **+1 845 675 7505** (E.164 `+18456757505`) or any Twilio number into this app first. Twilio remains the call transport; ElevenLabs is used only for **TTS** (MP3) that Twilio plays with `<Play>`.

## Architecture (required)

1. Twilio **A call comes in** → `POST https://<YOUR_API_HOST>/api/twilio/voice/inbound` (this app).
2. This app returns TwiML: ElevenLabs audio URL for the greeting (or `<Say>` fallback), then `<Gather>` for speech.
3. After each utterance → `POST .../api/twilio/voice/gather` → OpenAI generates text → ElevenLabs TTS (or `<Say>` fallback) → TwiML loop.
4. Optional **Call status changes** → `POST .../api/twilio/voice/status` (204, empty body).

Do **not** point the primary inbound voice webhook at `https://api.us.elevenlabs.io/twilio/inbound_call` if this app should own the call.

## Twilio Console (number +18456757505)

| Setting | Value |
|--------|--------|
| A call comes in | Webhook |
| URL | `https://<YOUR_API_HOST>/api/twilio/voice/inbound` |
| HTTP | POST |
| Call status changes (optional) | `https://<YOUR_API_HOST>/api/twilio/voice/status` POST |

## Database / agent

- Agent **status** must be **ACTIVE** (not DRAFT / PAUSED / DISABLED).
- Map the Twilio number in **either** of these ways (both normalize to E.164 `+18456757505` on save for `Agent.twilioPhoneNumber`):
  - **`Agent.twilioPhoneNumber`** = `+18456757505` (recommended for a single number per agent), or
  - **`PhoneNumber`** row: `phoneNumber` = `+18456757505`, `status` = ACTIVE, linked to an ACTIVE agent.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PUBLIC_WEBHOOK_BASE_URL` | Public **HTTPS origin only** (no trailing `/api`). Used for Twilio signature URL reconstruction and absolute `<Play>` / Gather URLs. |
| `TWILIO_AUTH_TOKEN` | Required when `VALIDATE_TWILIO_SIGNATURES` is enabled (default in production). |
| `VALIDATE_TWILIO_SIGNATURES` | Set `false` only for local tunnel experiments. |
| `OPENAI_API_KEY` | LLM replies in the Gather loop. |
| `ELEVENLABS_API_KEY` | TTS for greeting + replies when origin is public HTTPS. |
| `ELEVENLABS_DEFAULT_VOICE_ID` | Optional; defaults in code if unset. Per-agent ElevenLabs voice when `voiceProvider` = `elevenlabs` and `voiceId` set. |
| `ELEVENLABS_MODEL_ID` | Optional TTS model override. |
| `DATABASE_URL` | Sessions + agent resolution. |
| `ENCRYPTION_KEY`, `JWT_SECRET` | Required for `/api/twilio/live-call-ready` “ready” gate. |
| `TRUST_PROXY` | Set `true` behind a reverse proxy so Twilio signatures match the public URL. |

## Readiness endpoints

- `GET /api/twilio/config-check` — webhook URLs, HTTPS checks, secrets flags.
- `GET /api/twilio/live-call-ready` — stricter gate when `LIVE_CALL_TEST_MODE=true`.

## Structured logs (grep / observability)

| `event` | Meaning |
|---------|---------|
| `twilio.voice.inbound_received` | Twilio posted to inbound webhook. |
| `twilio.voice.agent_resolved` | DB matched `To` to an ACTIVE agent. |
| `twilio.voice.agent_not_resolved` | No agent; generic fallback TwiML. |
| `twilio.voice.llm_reply_generated` | OpenAI path returned assistant text. |
| `twilio.voice.llm_reply_skipped` / `llm_reply_failed` | No speech or runtime error. |
| `twilio.voice.elevenlabs_audio_generated` | MP3 bytes received from ElevenLabs and cached for `<Play>`. |
| `twilio.voice.tts_fallback` | ElevenLabs skipped or failed; next prompt uses Twilio `<Say>`. |
| `twilio.voice.twiml_returned` | TwiML sent; includes `ttsFallbackUsed`, `playbackChannel`. |
| `twilio.voice.tts_audio_served` | Twilio fetched one-time TTS MP3 URL. |
| `twilio.voice.status_received` / `status_applied` | Status callback handled. |

## Test locally

1. Run API (`PORT=3001`), Postgres, set `.env`: `PUBLIC_WEBHOOK_BASE_URL` = ngrok HTTPS origin, `VALIDATE_TWILIO_SIGNATURES=false` for quick tests, keys for OpenAI + ElevenLabs.
2. `pnpm` / `npm` in `apps/api`: start the server.
3. Expose with ngrok: `ngrok http 3001` → copy `https://....ngrok-free.app` into `PUBLIC_WEBHOOK_BASE_URL` (no `/api`).
4. `curl -s https://<ngrok>/api/twilio/config-check` — confirm `ready` and URLs.
5. Simulate Twilio POST (no signature in dev):  
   `curl -X POST "http://127.0.0.1:3001/api/twilio/voice/inbound" -H "Content-Type: application/x-www-form-urlencoded" --data-urlencode "CallSid=CAtest123" --data-urlencode "From=+15551234567" --data-urlencode "To=+18456757505"`  
   Expect `200` and `text/xml` with `<Response>`; logs should show `inbound_received` → `agent_resolved` (if DB configured) or `agent_not_resolved`.

## Test on the real Twilio number

1. Deploy API with production env; `PUBLIC_WEBHOOK_BASE_URL` must exactly match the URL Twilio calls (scheme + host + path prefix as configured).
2. Twilio Console: set voice webhooks as above; remove ElevenLabs inbound URL as primary.
3. Enable signature validation: `VALIDATE_TWILIO_SIGNATURES` unset/true, correct `TWILIO_AUTH_TOKEN`.
4. Call +18456757505 from a cell phone; confirm greeting (ElevenLabs or `<Say>`), speak, hear reply.
5. Watch logs for the events in the table above.

## Go-live checklist

- [ ] Twilio voice **primary** URL = this app `/api/twilio/voice/inbound` (POST).
- [ ] Status callback set if you want call completion analytics (POST `/api/twilio/voice/status`).
- [ ] `PUBLIC_WEBHOOK_BASE_URL` = public HTTPS **origin only**; `TRUST_PROXY=true` if behind nginx/ingress.
- [ ] `TWILIO_AUTH_TOKEN` matches the Twilio account that owns the number.
- [ ] `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `DATABASE_URL`, `ENCRYPTION_KEY`, `JWT_SECRET` set.
- [ ] ACTIVE agent with `twilioPhoneNumber` **+18456757505** (or ACTIVE `PhoneNumber` row) after saving through API (stored E.164).
- [ ] `GET /api/twilio/live-call-ready` → `ready: true` (with `LIVE_CALL_TEST_MODE=true` before launch if you use that gate).
- [ ] Run Prisma migrations (includes index on `Agent.twilioPhoneNumber` for routing).
- [ ] Place a test call; confirm `twilio.voice.tts_audio_served` when using ElevenLabs.
