# Production Release Runbook — v4.15.0

SureShot Books Twilio Voice Agent — checkout certification and payment hardening.

## Pre-deploy checklist

- [ ] Full pytest suite passes (`python -m pytest -q`)
- [ ] Release gate PASS (`python scripts/predeploy_release_gate.py`)
- [ ] `check_agent_runtime.py` all OK
- [ ] Staging smoke call completed (`scripts/run_staging_voice_smoke_plan.py`)
- [ ] PM2 logs verified (`scripts/verify_staging_voice_logs.py --sid <CALL_SID>`)
- [ ] No `.env` committed
- [ ] `VOICE_LIVE_DISABLE_OPENAI_TOOLS=true`
- [ ] `VOICE_AGENT_RUNTIME_MODE=main_llm_agent` (not `legacy_v410`)

## Env flags (certification)

| Flag | Default | Purpose |
|------|---------|---------|
| `VOICE_PAYMENT_CERTIFICATION_MODE` | `false` | Enable certification instrumentation |
| `VOICE_PAYMENT_CERTIFICATION_DRY_RUN` | `true` | Dry-run checkout/email locally |
| `VOICE_PAYMENT_CERTIFICATION_ALLOW_REAL_CHECKOUT` | `false` | Staging real Shopify checkout |
| `VOICE_PAYMENT_CERTIFICATION_ALLOW_REAL_EMAIL` | `false` | Staging real Resend send |
| `VOICE_PAYMENT_CERTIFICATION_TEST_EMAILS` | `` | Comma-separated allowlist |
| `VOICE_PAYMENT_IDEMPOTENCY_TTL_SECONDS` | `1800` | Duplicate link TTL |
| `VOICE_CATALOG_PARALLEL_SEARCH_LIMIT` | `4` | Max concurrent identifier searches |

**Local/dev:** keep dry-run defaults.  
**Staging certification:** set `VOICE_PAYMENT_CERTIFICATION_MODE=true`, enable real flags only for smoke, restrict emails to allowlist.  
**Production:** certification mode off unless intentional smoke.

## Staging certification steps

1. Deploy to staging (do not modify production `.env`).
2. Set certification flags and allowlisted test emails only.
3. Run smoke plan scenarios A–Q from `scripts/run_staging_voice_smoke_plan.py`.
4. Confirm one single-group payment link (book) end-to-end.
5. Confirm two-group payment (books + newspaper) with two emails.
6. Repeat "send payment link" — expect duplicate block, not second checkout.
7. Verify logs with `verify_staging_voice_logs.py`.

## Confirm payment link sent safely

Payment link is **only** confirmed when **both**:

1. Checkout created — log: `payment_link_created url_masked=True` or `checkout_certifier_success`
2. Email sent — log: `payment_link_email_sent masked_email=***`

Agent must **not** say "sent" unless `payment_link_email_sent` appears after checkout success.

## PM2 log inspection

```bash
pm2 logs twilio-voice-agent --lines 500 | grep <CALL_SID_PREFIX>
python scripts/verify_staging_voice_logs.py --sid <CALL_SID> --log-file /path/to/log
```

## Bad log markers (investigate immediately)

- `legacy_v410`
- `llm_brain_decision` on commerce turns
- `tool_calls` / `role=tool`
- Raw checkout URLs in logs or speech
- Unmasked full email addresses
- `Processing Fee` spoken or logged
- "sent" without `payment_link_email_sent`
- Duplicate `payment_link_created` for same idempotency key

## Rollback instructions

1. SSH to server; identify current and previous release dirs.
2. Stop PM2 process: `pm2 stop twilio-voice-agent`
3. Rollback symlink to previous release:
   ```bash
   ln -sfn /path/to/releases/v4.14.x /path/to/current
   ```
4. Restart: `pm2 start twilio-voice-agent`
5. Verify health: `python scripts/check_agent_runtime.py`
6. Place test call — order lookup + ISBN search only (no payment).
7. Monitor PM2 logs for 15 minutes.

## Twilio URL sanity check

- `PUBLIC_BASE_URL` must be HTTPS.
- ConversationRelay WebSocket derived from `PUBLIC_BASE_URL`.
- Twilio voice webhook points to staging/production base URL.

## Health check expected output

`check_agent_runtime.py` should show:

- Agent runtime mode: `main_llm_agent`
- OpenAI tools live: `blocked`
- Payment certification mode: configured
- Real checkout guard: OK
- Real email allowlist guard: OK
- Payment idempotency: OK

## What NOT to do

- Do **not** enable OpenAI live tools (`VOICE_LIVE_DISABLE_OPENAI_TOOLS` must stay `true`).
- Do **not** commit `.env` or secrets.
- Do **not** speak raw checkout URLs to callers.
- Do **not** say "sent" before Resend/backend confirms email success.
- Do **not** mention Processing Fee.
- Do **not** weaken PaymentSafetyGuard.
- Do **not** send real payment emails outside allowlist during certification.
