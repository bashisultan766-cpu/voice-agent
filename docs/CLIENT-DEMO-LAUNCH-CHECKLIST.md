# Client demo — staging to production launch checklist

Real provider validation for the realtime voice commerce agent. No mock products, checkout, emails, or latency.

## Commands

| Command | Purpose |
|---------|---------|
| `pnpm client-demo:readiness` | Full pre-demo validation (providers, Shopify, Resend, voice probes) |
| `pnpm client-demo:live-call-test` | Readiness + real Twilio outbound call + commerce trace |

Reports are printed to the console and saved under `client-demo-reports/` (override with `CLIENT_DEMO_REPORT_DIR`).

## Required environment

| Variable | Purpose |
|----------|---------|
| `DEV_TENANT_ID` / `DEV_AGENT_ID` | Target agent in your database |
| `DATABASE_URL` | Postgres |
| `DEV_TEST_CUSTOMER_EMAIL` | Customer email used for real checkout + payment email |
| `PUBLIC_WEBHOOK_BASE_URL` | Public HTTPS API origin (Twilio + media stream) |
| `CLIENT_DEMO_EMAIL_ALLOWLIST` | Comma-separated inboxes allowed to receive payment emails in staging |

Per-agent credentials (Shopify, Twilio, OpenAI, ElevenLabs, Resend) should be saved on the agent or workspace — env keys are fallback only when `ALLOW_PROVIDER_ENV_FALLBACK=true`.

Optional for full-duplex realtime: `REDIS_URL`, `VOICE_MEDIA_STREAM_ENABLED=true`, `OPENAI_REALTIME_ENABLED=true`, `REALTIME_MULTI_AGENT_ENABLED=true`.

## 1. Staging safety (before any demo)

- [ ] `CLIENT_DEMO_STAGING_MODE=true` on staging hosts
- [ ] `CLIENT_DEMO_EMAIL_ALLOWLIST` lists only your team's test inboxes
- [ ] Shopify **staging** store uses **test payment gateway** (Bogus Gateway / Shopify Payments test mode) — scripts never complete a real card charge
- [ ] `NODE_ENV=production` only on production; do **not** set `CLIENT_DEMO_STAGING_MODE=true` there
- [ ] `LIVE_CALL_TEST_MODE=true` only when `PUBLIC_WEBHOOK_BASE_URL` is your real HTTPS domain

## 2. Product & checkout (real Shopify)

Validated automatically by `client-demo:readiness`:

- [ ] Products exist in synced catalog (`pnpm dev:sync-shopify` if needed)
- [ ] Title search returns a match (`CLIENT_DEMO_PRODUCT_QUERY`)
- [ ] ISBN search works when `CLIENT_DEMO_PRODUCT_ISBN` is set
- [ ] Inventory and price present on `getProductDetails`
- [ ] Real HTTPS checkout link created via `createCheckoutLink` (storefront or draft invoice per agent config)

## 3. Email (real Resend)

- [ ] `RESEND_API_KEY` + sender configured on agent/workspace
- [ ] Payment email sends only to `CLIENT_DEMO_EMAIL_ALLOWLIST` addresses when allowlist is set
- [ ] Delivery confirmed in DB (`emailEvent` status) and optionally via Resend API (`GET /emails/{id}`)
- [ ] Unapproved recipients are blocked at runtime in `ResendEmailService`

## 4. Voice (real Twilio, OpenAI, ElevenLabs)

Readiness probes (real API calls):

- [ ] Twilio account + inbound webhook URL matches agent readiness
- [ ] OpenAI API + OpenAI Realtime WebSocket (when `OPENAI_REALTIME_ENABLED=true`)
- [ ] ElevenLabs TTS synthesis (when agent uses ElevenLabs)
- [ ] Media stream route reachable at `{PUBLIC_WEBHOOK_BASE_URL}/api/realtime-voice/media-stream`
- [ ] `GATHER_FALLBACK_ENABLED=true` for realtime → Gather recovery

Live call test (`pnpm client-demo:live-call-test`):

- [ ] Set `CLIENT_DEMO_CALL_FROM` (Twilio-owned) and `CLIENT_DEMO_CALL_TO` (agent inbound E.164)
- [ ] Call connects; optional: answer and speak to validate barge-in manually
- [ ] Trace ID appears in report and call session metadata

## 5. Payment safety

| Environment | Checkout | Card charge |
|-------------|----------|-------------|
| Staging / demo | Real Shopify staging products & links | Test gateway only; no automated real payment |
| Production | Real Shopify checkout | Customer completes on Shopify; no demo scripts |

## 6. Observability

Each run reports:

- Trace ID (`vtrace_*`)
- Latency: product search, checkout creation, email send/delivery, call connect
- Provider errors list
- Per-check pass/fail with fix hints

Grep production logs: `voice.e2e.*`, `payment_email.*`, `twilio.voice.*`.

## 7. Go-live sequence

1. `pnpm client-demo:readiness` on staging → **PASS**
2. `pnpm client-demo:live-call-test` on staging → **PASS**
3. Manual call to agent number: greeting → product question → checkout email
4. Complete payment on staging store with **test card** only
5. Deploy production with `CLIENT_DEMO_EMAIL_ALLOWLIST` **unset** (or empty) so live customer emails work
6. `GET /api/twilio/live-call-ready?agentId=...` → `ready: true`
7. Agent status **ACTIVE**; Twilio voice webhook → `/api/twilio/voice/inbound`

## Related docs

- [TWILIO-LIVE-CALL-CHECKLIST.md](./TWILIO-LIVE-CALL-CHECKLIST.md)
- [client-handover/08-go-live-checklist/GO-LIVE-CHECKLIST.md](../client-handover/08-go-live-checklist/GO-LIVE-CHECKLIST.md)
