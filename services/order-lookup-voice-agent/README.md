# SureShot Books — Order Lookup Voice Agent

Production AI voice agent for SureShot Books (Shopify bookstore).

## Architecture

```
Caller → Twilio (transport only)
      → POST /voice/twilio/inbound
      → conversationOrchestrator (brain + Shopify tools)
      → ElevenLabs API (ALL speech — direct HTTP)
      → MP3 stored + served at /voice/twilio/audio/{id}.mp3
      → TwiML <Play> + <Gather> back to Twilio
```

**Twilio never generates voice.** No ConversationRelay. No Polly `<Say>`.

## Twilio webhooks

| URL | Purpose |
|-----|---------|
| `POST /voice/twilio/inbound` | Answer call, play greeting, start speech gather |
| `POST /voice/twilio/turn` | Process caller speech, play brain response |
| `GET /voice/twilio/audio/:id.mp3` | Serve ElevenLabs MP3 for `<Play>` |
| `POST /voice/twilio/status` | Cleanup session on call end (optional) |

Legacy alias: `POST /conversationBrain/inbound` → same as inbound.

## Required .env

- `PUBLIC_BASE_URL` — HTTPS domain (Twilio must reach audio URLs)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
- `OPENAI_API_KEY`
- `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`
- `ELEVENLABS_API_KEY`, `VOICE_ID` — **required** for all TTS

## VPS deploy

```bash
cd /var/www/voice-agent && git pull origin main
cd services/order-lookup-voice-agent
cp .env.example .env   # edit with real secrets
npm ci && npm run build
pm2 restart order-lookup-voice-agent --update-env
curl -s http://127.0.0.1:8001/health
```

Twilio Console → Phone Number → Voice:
- **A call comes in:** `https://agent.mailcallcommunication.com/voice/twilio/inbound`
- **Status callback (optional):** `https://agent.mailcallcommunication.com/voice/twilio/status`

## Tests

```bash
npm test
```
