# voice-agent

FastAPI service for the SureShot Books AI voice call-center.
Receives Twilio Media Streams WebSockets, runs Deepgram STT → OpenAI LLM → OpenAI TTS,
and executes 13 Shopify/business tools.

## Python version — MUST be 3.11 or 3.12

`audioop` (stdlib audio resampling used for µ-law ↔ PCM conversion) was deprecated
in Python 3.11 and **removed in Python 3.13**.  Do not run this service on Python 3.13+.

```
# correct
python3.11 -m venv .venv
python3.12 -m venv .venv

# will break at import time
python3.13 -m venv .venv   # audioop missing → pcm16_to_mulaw raises ImportError
```

If you need Python 3.13+, replace `audioop` calls in `app/pipeline/audio.py` with
[audioop-lts](https://pypi.org/project/audioop-lts/) before upgrading.

## Quick start

```bash
cd services/voice-agent
python3.11 -m venv .venv
source .venv/Scripts/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cp .env.example .env            # fill in OPENAI_API_KEY, TWILIO_AUTH_TOKEN, BASE_URL

uvicorn app.main:app --reload --port 8000
```

Set `TWILIO_VALIDATE_REQUESTS=false` in `.env` for local dev (ngrok URLs change per
session and break the signature hash).  Set `true` in production.

## Milestones

| # | Status | Description |
|---|--------|-------------|
| 1 | done   | Scaffold: core/config.py, pipeline stubs, tools/, clients/ |
| 2 | done   | Twilio Media Streams WebSocket + hardcoded TTS greeting |
| 3 | next   | Deepgram Nova-2 STT streaming (speech_final endpointing) |
| 4 | —      | OpenAI streaming LLM + tool-call loop |
| 5 | —      | Barge-in (cancel TTS on Deepgram speech_started) |
| 6 | —      | Remaining 9 tools (tools 5–13) |
