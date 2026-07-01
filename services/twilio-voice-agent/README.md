# Twilio ConversationRelay Voice Agent

Production voice sales agent for Shopify bookstores (SureShot Books). Twilio handles STT/TTS; this service exchanges plain-text JSON over a WebSocket and runs a single LLM tool-calling runtime.

## Live runtime path

```
Twilio inbound call
  → POST /voice/twilio/inbound (TwiML + signed WS token)
  → WebSocket /voice/twilio/ws (ConversationRelay)
  → voice/turn_assembler
  → agent_runtime/llm_tool_runtime
  → agent_runtime/llm_tools
  → tools/ (Shopify, Resend email, payment) + Redis session store
  → Twilio text response (TTS)
```

There is **one** live turn handler: `llm_tool_runtime`. Legacy worker/composer/brain/pipeline paths were archived under `archive_legacy/`.

**Step 3 (optional):** Set `VOICE_ORCHESTRATOR_ENABLED=true` to route through `app/orchestrator/` (supervisor → planner → tools → composer). Default is `false` — `llm_tool_runtime` remains production path until certified.

## Local setup

```bash
cd services/twilio-voice-agent
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# Fill OPENAI_API_KEY, TWILIO_*, SHOPIFY_*, RESEND_*, REDIS_URL (optional locally)
uvicorn app.main:app --reload --port 8000
```

Expose port 8000 with ngrok (or similar) and point Twilio voice webhook to `https://<host>/voice/twilio/inbound`.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `APP_ENV` | `development` \| `test` \| `production` — controls Redis fallback and docs |
| `REDIS_URL` | Session store, rate limits, payment idempotency (**required in production**) |
| `OPENAI_API_KEY` | LLM tool runtime |
| `OPENAI_MODEL` | Chat model (default `gpt-4o-mini`) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Webhook signature + WS token signing |
| `PUBLIC_BASE_URL` | Public HTTPS base for TwiML WebSocket URL |
| `SHOPIFY_SHOP_DOMAIN` / `SHOPIFY_ADMIN_ACCESS_TOKEN` | Catalog, checkout, orders |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | Payment link email delivery |
| `INTERNAL_ADMIN_KEY` | `X-Admin-Key` for `POST /admin/sync` |
| `WS_TOKEN_VALIDATION_ENABLED` | Validate signed token on WebSocket connect (default `true`) |
| `ENABLE_API_DOCS` | FastAPI `/docs` (auto-off in production unless `DEBUG=true`) |
| `VOICE_AGENT_RUNTIME_MODE` | Must be `llm_tool_runtime` |

See `.env.example` for the full list.

## Memory model

- **Per-call session**: `SessionState` in Redis (`session:{id}`), keyed by Twilio `callSid`.
- **Conversation history**: last N turns in `session.history` for LLM context.
- **Payment state**: deterministic FSM in `payment/email_state.py` and `payment/payment_state_machine.py` — `confirmed_email`, cart confirmation, checkout URL.
- **Call resume**: optional phone-keyed snapshot in Redis for returning callers.

## Payment safety rules (enforced in code)

Payment links are blocked unless **all** of the following are true:

1. Cart exists with at least one valid Shopify `variant_id`
2. Caller explicitly confirmed the cart (`payment_cart_confirmed`)
3. Email captured and normalized from speech
4. Email read back and verbally confirmed (`email_verified` / `payment_email_confirmed`)
5. Checkout/draft order created successfully (`checkout_url` present)
6. Send uses `confirmed_email` only — LLM email arguments must match
7. Idempotency check passes (no duplicate send for same cart/email)

Guards live in `payment/safety.py`, `agent_runtime/tool_runtime_gates.py`, and `agent_runtime/payment_flow_state.py`.

## Email FSM

States: `idle` → `awaiting_email` → `awaiting_email_confirmation` → `email_confirmed` → `awaiting_payment_send_confirmation` → `payment_link_sent`.

Spoken email is normalized (e.g. `john dot smith at gmail dot com` → `john.smith@gmail.com`), read back in full for confirmation, and only then stored as `confirmed_email`. Changing email after confirmation requires reconfirmation.

## Security

- Twilio webhook HMAC validation (`VALIDATE_TWILIO_SIGNATURES`)
- Signed short-lived WebSocket token (`callSid`, `from`, `exp`) minted at inbound, validated at WS connect
- Admin sync requires `X-Admin-Key` (never logged) + rate limit
- Rate limits on inbound webhook, WS setup, admin sync (Redis in production)
- FastAPI `/docs`, `/redoc`, `/openapi.json` disabled in production by default
- PII-safe logging: masked phone/email only; no API keys in logs

## Observability

- Structured tool events: `tool_event=started|succeeded|failed|blocked_by_guard`
- `GET /health` — app status, Redis status, service configured flags, runtime identity (no secrets)

## Tests

```bash
cd services/twilio-voice-agent
python -m compileall app -q
python -m pytest -q --tb=short

# Focused hardening suites
python -m pytest app/tests/test_shopify_tools.py -q
python -m pytest app/tests/test_step2_hardening.py -q
python -m pytest app/tests/test_v411_payment_safety.py -q
```

## Production deployment

1. Set `APP_ENV=production` and `REDIS_URL` — app **fails startup** if Redis is unreachable.
2. Set all required secrets; do not enable `DEBUG`.
3. Ensure `PUBLIC_BASE_URL` matches the TLS endpoint Twilio calls.
4. PM2/systemd: `uvicorn app.main:app --host 0.0.0.0 --port 8000`
5. Use `scripts/vps-deploy.sh` if configured for your environment.

## Reliability

- OpenAI: one retry on timeout/rate-limit/5xx with backoff; safe spoken fallback on failure
- Shopify: circuit breaker after repeated failures; cache reads may continue
- Resend: limited retry on 429/5xx; payment idempotency in Redis (production)
