# Twilio ConversationRelay Voice Agent

AI phone sales agent for Shopify bookstores, specialising in books for incarcerated individuals (SureShot Books). Uses **Twilio ConversationRelay** for managed STT/TTS — this service handles only plain-text JSON over WebSocket. No Deepgram, no ElevenLabs, no raw audio.

## Architecture

### v4.1.1 — Global Payment Safety Guard (current)

Closes the final P0 vulnerability: the LLM fallback tool path (`send_payment_link_email_tool`) accepted raw email arguments without verifying `session.confirmed_email`.

**New module: `app/payment/safety.py` — `PaymentSafetyGuard`**

- `get_confirmed_email(session)` — returns `confirmed_email` or `None`; never `pending_email`
- `require_confirmed_email(session)` — allowed only when `confirmed_email` is set
- `require_confirmed_cart(session)` — items exist, qty ≥ 1, variant_id set
- `require_payment_send_ready(session)` — full gate: confirmed_email + checkout_url
- `validate_tool_email_arg(arg, session)` — validates LLM email arg; blocks rejected candidates

**Changes:**
- `send_payment_link_email_tool` — uses `validate_tool_email_arg`; sends to `confirmed_email` only
- `create_checkout_link` — gates on confirmed cart; ignores unconfirmed LLM email args; blocks rejected candidate emails
- `CheckoutWorker` — uses `confirmed_email` instead of `caller_email`
- `_apply_email_state` (engine.py) — stores rejected emails in `session.rejected_email_candidates`
- 23 new tests → **660/660 passing**

### v4.1 — Production Bug Fixes

Addresses 11 live-call bugs:

1. **Shopify GraphQL fix** — removed invalid `metafields(identifiers:...)` (Storefront API only); added `GET_PRODUCT_METAFIELDS` with correct Admin API connection syntax.
2. **Email capture (P0)** — deterministic spoken→typed normalizer (`email_capture.py`); confirmation state machine (`pending_email` → confirmed → `confirmed_email`); `PaymentEmailWorker` now uses `confirmed_email` only — refuses to send if unconfirmed.
3. **Router v4.1** — 11 new intents: `email_provided`, `email_correction`, `email_confirmation`, `multi_book_order`, `book_title_search`, `facility_approval`, `facility_restriction`, `refund_detail`, `cancellation_request`, `address_update`, `quantity_update`, `shipping_price`.
4. **Facility/inmate workers** — `FacilityApprovalWorker`, `FacilityRestrictionWorker`, `FacilityPolicyNotesWorker`, `OrderFacilityReviewWorker` — data from Shopify order notes/tags/attributes; never guesses approval; escalates if unknown.
5. **Enhanced RefundWorker** — shipping refund status, per-item detail, safe reason/note, masked email in result.
6. **System prompt v4.1** — agent name **Eric**, SureShot Books, facility/inmate context, never mention AI, never say "Processing Fee", confirmed email rules.
7. **Privacy logging** — `_mask_phone()` in all `conversation_relay.py` log lines; `_mask_email()` in `PaymentEmailWorker` and `RefundWorker`.

### v4.0 — Worker-First Pipeline

```
Twilio Phone Call
    │
    ▼
POST /voice/twilio/inbound        ← Twilio webhook
    │ Returns TwiML <ConversationRelay>
    │
    ▼
WebSocket /voice/twilio/ws        ← ConversationRelay WS
    │
    │  Twilio sends:  { type:"setup" | "prompt" | "interrupt" | "dtmf" | "error" }
    │  We send:       { type:"text", token:"...", last:false/true }
    │
    ▼
RealtimePipelineEngine            ← app/pipeline/engine.py
    │  1. Intent router (regex, no LLM) → intent + entities
    │  2. Filler phrase (if VOICE_FILLER_AFTER_MS > 0 and workers are slow)
    │  3a. WORKER PATH (tool intents): WorkerOrchestrator → 13 async workers
    │  3b. FALLBACK PATH (conversational): run_agent_turn (OpenAI + tools)
    │
    ├─ WORKER PATH ──────────────────────────────────────────────────────────
    │      WorkerOrchestrator (asyncio.gather, per-worker timeout)
    │          ├─ CallerIdentityWorker   ← CustomerCache only
    │          ├─ CustomerProfileWorker  ← CustomerCache only
    │          ├─ ProductISBNWorker      ← ProductCache → Shopify
    │          ├─ ProductSearchWorker    ← ProductCache → Shopify
    │          ├─ PriceInventoryWorker   ← ProductCache only
    │          ├─ OrderLookupWorker      ← OrderCache → Shopify
    │          ├─ TrackingWorker         ← OrderCache only
    │          ├─ RefundWorker           ← verification gate → Shopify
    │          ├─ ShippingWorker         ← static config
    │          ├─ CheckoutWorker         ← Shopify draft order
    │          ├─ PaymentEmailWorker     ← Resend
    │          ├─ EscalationWorker       ← Shopify + Resend
    │          └─ StorePolicyWorker      ← static text
    │      MainLLMComposer               ← app/composer/main_llm_composer.py
    │          └─ ONE call to OpenAI (no tool loop), compact safe context
    │
    ├─ FALLBACK PATH ───────────────────────────────────────────────────────
    │      run_agent_turn (OpenAI + tool loop)  ← app/ai/openai_agent.py
    │          └─ greeting / confirmation / email_capture / unknown intents
    │
    ▼
Caller hears synthesised voice (Twilio TTS, Google Neural2-J)

─────────────────────────────────────────────────────
POST /webhooks/shopify/*          ← Shopify webhooks
    │  HMAC-verified, fast 200, background processing
    ▼
Local Shopify Cache (Redis)       ← app/sync/
    │  ProductCache / CustomerCache / OrderCache
    ▼
python -m app.sync.shopify_sync   ← Initial full sync
POST /admin/sync                  ← Admin trigger (X-Admin-Key)
```

### Single-LLM Rule

**Only `app/composer/main_llm_composer.py` is permitted to import `openai` or call the OpenAI API** (via the worker path). The legacy `run_agent_turn` in `app/ai/openai_agent.py` handles conversational fallback. No other file may call OpenAI. This is enforced by an AST-level test in `test_composer.py`.

Workers are deterministic async Python — they hit Redis caches, Shopify, or return static data. They never call an LLM.

### Why This Is Fast

| Technique | Benefit |
|-----------|---------|
| Workers run concurrently (`asyncio.gather`) | Parallel Shopify + cache lookups |
| ProductCache / OrderCache checked first | Sub-ms Redis hit; no Shopify call |
| Single OpenAI call with no tool loop | Eliminates iterative round-trips |
| Filler sent before workers start | Caller hears response while workers run |
| `VOICE_SHOPIFY_TIMEOUT_MS` hard cap | Worker never blocks > N ms |
| Cache hit skips filler entirely | Fastest path: cache → composer → speak |

## Features

| # | Feature | Files |
|---|---------|-------|
| 1 | Returning caller recognition | `app/caller/` |
| 2 | ISBN / barcode product search | `app/tools/isbn.py`, `app/shopify/graphql_queries.py` |
| 3 | Enhanced order lookup with verification gating | `app/tools/shopify_tools.py` |
| 4 | `get_refund_status` tool | `app/tools/shopify_tools.py` |
| 5 | Draft order with duplicate prevention | `app/tools/shopify_tools.py` |
| 6 | `send_payment_link_email` tool via Resend | `app/tools/email_sender.py` |
| 7 | SessionState cart/checkout/verification tracking | `app/state/models.py` |
| 8 | Enhanced bookstore system prompt (VOICE_MAX_REPLY_WORDS controlled) | `app/ai/system_prompt.py` |
| 9 | Escalation support email notification | `app/tools/shopify_tools.py` |
| 10 | Realtime pipeline engine — intent router, prefetch, filler, latency | `app/pipeline/` |
| 11 | Local Shopify cache — ProductCache, CustomerCache, OrderCache | `app/sync/repositories.py` |
| 12 | Initial Shopify sync worker | `app/sync/shopify_sync.py` |
| 13 | Shopify webhook handlers (products/orders/customers/refunds) | `app/sync/webhooks.py` |
| 14 | Call setup prefetch — warms caller/order data from Redis at call start | `app/pipeline/engine.py` |
| 15 | Compact router context — intent/entity injection, masked PII, no raw JSON | `app/pipeline/engine.py` |
| 16 | Latency tracing — structured per-turn timing log | `app/pipeline/latency.py` |
| 17 | Speed budget env vars — all wired into runtime | `app/config.py`, `.env.example` |
| 18 | **v4.0** Single-LLM composer (only component allowed to call OpenAI) | `app/composer/main_llm_composer.py` |
| 19 | **v4.0** 13 deterministic async workers (no LLM calls) | `app/workers/` |
| 20 | **v4.0** WorkerOrchestrator — concurrent dispatch, per-worker timeout | `app/workers/orchestrator.py` |
| 21 | **v4.0** Dual-path engine — worker path for tool intents, fallback for conversational | `app/pipeline/engine.py` |
| 22 | **v4.0** ProductCache first-check in `search_products` (title/ISBN/handle) | `app/tools/shopify_tools.py` |
| 23 | **v4.0** `VOICE_SHOPIFY_TIMEOUT_MS` takes precedence over legacy timeout | `app/shopify/client.py` |
| 24 | **v4.0** Full latency instrumentation — shopify_api_ms / resend_api_ms from workers | `app/pipeline/engine.py` |
| 25 | **v4.1** Email normalizer — spoken→typed, confidence score, confirmation state machine | `app/pipeline/email_capture.py` |
| 26 | **v4.1** PaymentEmailWorker uses confirmed_email only — refuses to send if unconfirmed | `app/workers/payment_email_worker.py` |
| 27 | **v4.1** Facility/inmate workers — approval, restriction, policy notes, order review | `app/workers/facility_*_worker.py` |
| 28 | **v4.1** Enhanced RefundWorker — shipping refund, item detail, safe note, masked email | `app/workers/refund_worker.py` |
| 29 | **v4.1** System prompt — Eric/SureShot Books/facility context, no AI disclosure | `app/ai/system_prompt.py` |
| 30 | **v4.1** Router v4.1 — 11 new intents, bidirectional facility patterns, shipping_price | `app/pipeline/router.py` |
| 31 | **v4.1** Privacy logging — phone masked to last-4, email masked in all log lines | `app/ws/conversation_relay.py` |

## Environment Variables

Copy `.env.example` to `.env` and fill in the values.

```bash
cp .env.example .env
```

### Required

| Variable | Description |
|----------|-------------|
| `PUBLIC_BASE_URL` | HTTPS base URL for this service, e.g. `https://voice.example.com`. Derives the ConversationRelay WebSocket URL (`wss://…/voice/twilio/ws`). |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID (`ACxxxxxx…`) |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token (used for webhook signature validation) |
| `OPENAI_API_KEY` | OpenAI API key for GPT-4o-mini chat completions |

### Shopify

| Variable | Description |
|----------|-------------|
| `SHOPIFY_SHOP_DOMAIN` | Store domain without `https://`, e.g. `your-store.myshopify.com` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Admin API token (`shpat_…`) — never logged or returned to callers |
| `SHOPIFY_API_VERSION` | API version, default `2026-01` |

**Required Shopify scopes:** `read_products`, `read_orders`, `read_customers`, `write_draft_orders`, `read_refunds`

### Resend (email)

| Variable | Description |
|----------|-------------|
| `RESEND_API_KEY` | API key from [resend.com](https://resend.com) — required for `send_payment_link_email` |
| `RESEND_FROM_EMAIL` | Verified sender address |
| `RESEND_FROM_NAME` | Display name in the From header |
| `SUPPORT_EMAIL` | If set, escalation events send a plain text notification here |

### Redis

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://127.0.0.1:6379` | Used for sessions, Shopify cache, and caller profiles. Falls back to in-memory dict on connection failure (single-instance only). |

### Pipeline Speed Budgets

| Variable | Default | Description |
|----------|---------|-------------|
| `VOICE_FIRST_PROMPT_PROFILE_TIMEOUT_MS` | `750` | How long the first turn waits for caller profile to load |
| `VOICE_TOOL_TIMEOUT_MS` | `2500` | Per-tool timeout for speculative prefetch and live calls |
| `VOICE_SHOPIFY_TIMEOUT_MS` | `2500` | Shopify GraphQL per-request hard timeout |
| `VOICE_OPENAI_TIMEOUT_MS` | `8000` | OpenAI streaming call timeout |
| `VOICE_FILLER_AFTER_MS` | `250` | Emit filler phrase after this many ms for tool intents |
| `VOICE_MAX_REPLY_WORDS` | `50` | Soft limit on LLM reply length (words) |

### Webhooks

| Variable | Description |
|----------|-------------|
| `SHOPIFY_WEBHOOK_SECRET` | HMAC secret from Shopify admin (Settings → Notifications). Required to validate `POST /webhooks/shopify/*`. |
| `INTERNAL_ADMIN_KEY` | Protects `POST /admin/sync` — set `X-Admin-Key` header to this value to trigger a full sync. |

### Optional / Advanced

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_MODEL` | `gpt-4o-mini` | LLM model name |
| `OPENAI_TIMEOUT_SECS` | `30.0` | Per-request LLM timeout |
| `SHOPIFY_TIMEOUT_SECS` | `10.0` | Per-request Shopify API timeout |
| `SHOPIFY_CACHE_TTL_SECS` | `60` | Product search Redis cache TTL |
| `VALIDATE_TWILIO_SIGNATURES` | `true` | Set `false` for local dev with ngrok |
| `DEBUG` | `false` | Skips production env-var validation when `true` |
| `ENABLE_ELEVENLABS` | `false` | Must stay `false` — not used by this runtime |
| `ENABLE_DEEPGRAM` | `false` | Must stay `false` — not used by this runtime |

## Twilio Setup

1. Buy a Twilio phone number.
2. Set the **Voice** webhook URL to:
   ```
   https://your-domain.com/voice/twilio/inbound
   ```
3. Method: `HTTP POST`.
4. Twilio forwards calls here; the response TwiML opens the ConversationRelay WebSocket.

## Shopify Webhook Setup

Register webhooks in Shopify admin (Settings → Notifications → Webhooks):

| Topic | Endpoint |
|-------|----------|
| `products/create`, `products/update`, `products/delete` | `https://your-domain.com/webhooks/shopify/products` |
| `orders/create`, `orders/updated` | `https://your-domain.com/webhooks/shopify/orders` |
| `customers/create`, `customers/update` | `https://your-domain.com/webhooks/shopify/customers` |
| `refunds/create` | `https://your-domain.com/webhooks/shopify/refunds` |

Set the webhook signing secret as `SHOPIFY_WEBHOOK_SECRET` in `.env`.

## Initial Shopify Sync

Run a full sync to pre-populate the local Redis cache:

```bash
# From the service root
.venv/bin/python -m app.sync.shopify_sync
```

Or trigger via API (after setting `INTERNAL_ADMIN_KEY`):
```bash
curl -X POST https://your-domain.com/admin/sync \
  -H "X-Admin-Key: your-internal-admin-key"
```

The sync paginates through all products, customers, and orders, extracts ISBN/author metadata from barcodes/SKUs/tags/metafields, and writes to Redis. Each webhook event thereafter keeps the cache fresh. Cache TTLs: customers 1 hr, products 30 min, orders 15 min.

## Running

```bash
# Create venv and install
python -m venv .venv
.venv/bin/pip install -r requirements.txt

# Copy and fill in env vars
cp .env.example .env

# Start
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8001

# Dev with auto-reload
.venv/bin/uvicorn app.main:app --reload --port 8001
```

Local dev with ngrok:
```bash
ngrok http 8001
# Set PUBLIC_BASE_URL=https://<ngrok-id>.ngrok.io in .env
# Set VALIDATE_TWILIO_SIGNATURES=false
```

Via PM2 (production):
```bash
pm2 start ecosystem.config.cjs --only twilio-voice-agent
```

## Returning Caller Memory

On each call:
1. `setup` arrives → CallerProfile lookup starts as a background asyncio Task (task handle stored).
2. If profile exists and **loads before the caller speaks**:
   - Session pre-populated with name, masked email, last order number, call count, last call summary.
   - Personalised WS greeting spoken immediately: `"Welcome back, Darren!"`.
   - On the first prompt, `SafeCallerContext` is built with `greeted_already=True`.
   - System prompt tells the agent not to repeat the greeting.
3. If profile **loads during the brief await window** (up to 750 ms after first prompt):
   - `first_prompt_received=True` is set before the await — prevents a late WS greeting mid-conversation.
   - Session is populated; `SafeCallerContext` built with `greeted_already=False`.
   - LLM greets the caller warmly in its first response.
4. If profile **load exceeds 750 ms**:
   - Call proceeds immediately as a new caller — no blocking.
   - Profile task continues in background; if it completes later, session fields update for subsequent turns.
5. At call end → profile upserted (name, email, last order saved for 30 days).

**Profile loading is best-effort and safe — the call never blocks indefinitely.**

**Caller profile is used for personalisation only. It does not bypass verification.**

- Sensitive order/refund/payment data still requires email or phone verification.
- Caller summaries are short and non-sensitive (≤300 chars, human-written or omitted).
- Full transcripts are never stored in the caller profile.
- Secrets and payment card data are never stored or passed to the LLM.
- The masked email form (`d***n@example.com`) is used in the system prompt — raw email is never included even after verification.

Redis key: `caller:profile:{digits}` (30-day TTL).

## Security

- Shopify Admin token stored as `self.__token` (Python name-mangling) — never in `repr()` or logs.
- Order/payment/refund details require `order_number + email or phone` before disclosure.
- Caller phone masked in all log lines (`+1***67`).
- `RESEND_API_KEY` never logged.
- Stack traces never exposed to callers — tools return safe error strings.
- `validate_production()` at startup fails fast on missing secrets (non-DEBUG mode).
- Twilio webhook signature validated via `RequestValidator` on every POST.

## Tools

| Tool | Description | Verification |
|------|-------------|--------------|
| `search_products` | Search by title, author, genre, or ISBN (spoken/typed) | None |
| `get_product_details` | Full details for a product by GID or handle | None |
| `lookup_order` | Order status; full details require order# + email or phone | Yes for financial details |
| `get_refund_status` | Refund amounts and dates for an order | Yes (email or phone) |
| `create_checkout_link` | Creates Shopify draft order; prevents duplicate calls | None |
| `send_payment_link_email` | Emails payment link via Resend; prevents duplicate sends per call | None |
| `escalate_to_human` | Flags for callback; notifies `SUPPORT_EMAIL` | None |

## Intent Router

The pipeline runs a pure-regex intent classifier before every LLM call — no network I/O, microseconds latency.

### Intents

| Intent | Triggers | Suggested tools |
|--------|----------|-----------------|
| `isbn_search` | Bare or prefixed ISBN-10/13, spoken digits | `search_products` |
| `product_search` | Title/author/genre keywords | `search_products` |
| `order_status` | "order", order numbers like `#1042` | `lookup_order` |
| `refund_status` | "refund", "return" | `get_refund_status` |
| `create_order` | "buy", "purchase", "checkout" | `create_checkout_link` |
| `send_payment_link` | "email", "send link", "pay" | `send_payment_link_email` |
| `escalate` | "speak to someone", "manager", "help" | `escalate_to_human` |
| `greeting` | "hi", "hello" | — |
| `caller_verified` | email/phone confirmation phrases | — |
| `provide_email` | email address in utterance | — |
| `provide_phone` | formatted phone number in utterance | — |
| `cart_inquiry` | "cart", "bag", "items" | — |
| `unknown` | no pattern matched | — |

### Entities extracted

| Entity | Example | Notes |
|--------|---------|-------|
| `isbn` | `"9780306406157"` | ISBN-10 normalised to ISBN-13 when valid |
| `order_number` | `"#1042"` | `#` prefix always added |
| `email` | `"alice@example.com"` | Raw email, masked before passing to LLM |
| `product_phrase` | `"Dune by Frank Herbert"` | Title/author fragment |
| `quantity` | `"3"` | Numeric string; from spoken ("three copies") or numeric ("3 books") |
| `phone` | `"5551234567"` | Digits only; requires separators or `+1` prefix (avoids ISBN-10 ambiguity) |

## Compact Router Context

Before each LLM call the engine builds a compact `[ROUTER CONTEXT]` block and prepends it to the user message for that turn only — it is never stored in conversation history.

```
[ROUTER CONTEXT — detected before LLM call, no live data]
Intent: isbn_search (confidence: 0.95)
ISBN: 9780306406157
Quantity: 2
Prefetch cache: 1 result(s) ready
```

**Security rules enforced in context block:**
- Email always masked (`a***e@example.com`) — never raw.
- Phone redacted to last 4 digits (`***6666`).
- Never includes raw Shopify JSON, GIDs, card data, or secrets.
- `unknown` intent → no block injected.

The LLM receives this once so it can act on intent/entities immediately without re-parsing the caller's words.

## Local Shopify Cache

Implemented in `app/sync/repositories.py`. Uses Redis with an **in-memory dict fallback** when Redis is unavailable (single-instance only — not suitable for multi-replica deployments without Redis).

> **Note:** This service uses Redis (+ in-memory fallback) for all session, profile, and sync data. There is no Postgres dependency. Postgres persistence can be added later if needed.

### ProductCache

| Method | Key pattern | Description |
|--------|-------------|-------------|
| `get(product_id)` | `sync:product:{id}` | Lookup by Shopify GID |
| `get_by_title(title)` | `sync:product:title:{normalized}` | Case-insensitive, punctuation-stripped title lookup |
| `get_by_handle(handle)` | `sync:product:handle:{handle}` | Exact handle lookup |
| `set(product)` | writes all three keys | Writes primary + title + handle indexes |
| `search(query)` | scan `sync:product:*` | Full-text search over cached products |

`_normalize_title_key(title)` lowercases, strips non-word characters, collapses whitespace to `_`, and caps at 100 chars.

### CustomerCache

| Method | Key pattern |
|--------|-------------|
| `get_by_phone(phone)` | `sync:customer:phone:{normalized}` |
| `set(customer)` | writes phone index |

### OrderCache

| Method | Key pattern | Description |
|--------|-------------|-------------|
| `get_by_number(order_number)` | `sync:order:number:{stripped}` | Display order name lookup |
| `get_recent_by_phone(phone)` | `sync:order:phone:{phone}` | Most recent order for a phone |
| `get_by_shopify_id(id)` | `sync:order:gid:{gid}` | Accepts numeric ID or full GID string |
| `set(order)` | writes number + phone + GID indexes | |

## Latency Tracing

Every turn emits a structured log line via `app/pipeline/latency.py`:

```
LATENCY call_sid=CA1234 intent=isbn_search router=0.3ms prefetch=0.0ms filler=0.0ms tools=450.2ms openai_first=180.5ms total=634.1ms | call_setup=22.0ms shopify=445.0ms
```

### TurnLatency fields

| Field | When populated |
|-------|---------------|
| `router_ms` | Always — time to classify intent |
| `prefetch_ms` | When a speculative prefetch ran |
| `filler_ms` | When a filler phrase was sent |
| `tools_ms` | When the LLM called at least one tool |
| `openai_first_token_ms` | Time to first streamed token from OpenAI |
| `total_ms` | Always — wall time for the full turn |
| `call_setup_ms` | First turn only — time for `prefetch_on_call_setup()` |
| `caller_profile_lookup_ms` | First turn only — time waiting for caller profile task |
| `shopify_api_ms` | When a tool made a live Shopify GraphQL request |
| `resend_api_ms` | When `send_payment_link_email` called Resend |

Optional fields (`call_setup_ms`, `caller_profile_lookup_ms`, `shopify_api_ms`, `resend_api_ms`) are omitted from the log line when zero.

## Tests

```bash
cd services/twilio-voice-agent
.venv/bin/python -m pytest app/tests/ -v
```

637 tests, all mocked — no live API calls required. Coverage includes:

- Twilio inbound webhook and TwiML generation
- WebSocket message handling (setup, prompt, interrupt, dtmf, error)
- Tool schema validation (7 tools)
- Shopify tool implementations with mocked client
- ISBN normalization: spoken digits, hyphens, ISBN-10/13 conversion
- Caller profile CRUD and upsert logic
- Email sender: Resend API, key safety, invalid email, missing config
- Refund status: verified, unverified, no refunds, Shopify unavailable
- Caller context: SafeCallerContext fields, email masking, system prompt injection, no fake names
- Profile loading race fix: await_caller_profile_ready, timeout, duplicate greeting prevention
- Config validation: missing keys, legacy flag guard
- Intent router: 13 intents, entity extraction (phone, quantity, email, ISBN, order, product phrase)
- ISBN-10 router: bare, prefixed, hyphenated, normalized to ISBN-13
- Latency tracer: all TurnLatency fields (including v3.1 additions), structured log, no PII, extras omitted when zero
- Parallel tool executor: concurrent execution, timeout, partial failure, prefetch cache
- Pipeline engine: filler suppression, cancellation, caller context forwarding, router context injection, latency tracking
- Router context: intent/entity injection, email masking, phone redaction, no raw JSON; inject into first user message only
- Speed budget config: VOICE_* defaults and overrides, system prompt word-limit wiring, OpenAI timeout wiring
- ProductCache: title/handle index writes, get_by_title normalization, get_by_handle round-trip
- prefetch_on_call_setup: customer/order populated from cache, no overwrite of existing values, error resilience
- Refund webhook: order_name field lookup, GID fallback, old numeric-ID bug demonstrated, refund count increment
- Local cache repositories: CachedCustomer/Product/Order, Redis CRUD, round-trip serialisation
- Shopify sync worker: ingest functions, retry logic, pagination, email masking
- Webhook handlers: HMAC verification, 200 fast response, 401 on bad signature, admin sync
- **v4.0** Single-LLM rule: AST check that only `app/composer/` imports openai; workers never import openai or run_agent_turn
- **v4.0** All 13 workers: cache hit / cache miss / verification gate / error isolation for each worker
- **v4.0** WorkerOrchestrator: intent→worker mapping, concurrent dispatch, per-worker timeout, partial bundle, shopify/resend latency
- **v4.0** MainLLMComposer: single OpenAI call per turn, no tools= passed, worker data in messages, graceful error, history written
- **v4.0** Dual-path engine: tool intents use workers→composer; conversational intents use run_agent_turn fallback
- **v4.0** `VOICE_SHOPIFY_TIMEOUT_MS` precedence over `SHOPIFY_TIMEOUT_SECS` in ShopifyGraphQLClient
- **v4.0** ProductCache first-check in search_products: ISBN/title/handle hit skips Shopify; cache error falls through gracefully
- **v4.1** Email normalizer: spoken→typed (digit words, domain aliases, spaced letters), confidence scoring, confirmation state machine
- **v4.1** PaymentEmailWorker security: refuses send without confirmed_email; unconfirmed state prompts caller; duplicate guard uses confirmed_email
- **v4.1** Engine email state machine: email_provided sets pending, email_correction clears pending, email_confirmation promotes to confirmed
- **v4.1** FacilityApprovalWorker: tag/note/attribute parsing, approved/rejected/unknown status, session facility context
- **v4.1** FacilityRestrictionWorker: hardcover/used/publisher restriction detection, default guidance when no data
- **v4.1** FacilityPolicyNotesWorker: order note pull, default SureShot policy as fallback
- **v4.1** OrderFacilityReviewWorker: returned-by-facility tag detection, verification gate, facility issues in data
- **v4.1** Enhanced RefundWorker: shipping refund field, item detail, safe note (sensitive terms redacted), masked email
- **v4.1** Router v4.1: 11 new intents, facility bidirectional patterns, shipping_price plural fix
- **v4.1** Privacy logging: _mask_phone last-4 format, _mask_email, no full PII in any log line
- **v4.1** System prompt: Eric/SureShot Books/facility context, agent_name parameter override, no AI disclosure rule

## Roadmap

### ElevenLabs Voice (future)

Twilio ConversationRelay currently handles TTS using Twilio's built-in voices. A future upgrade path:

1. Replace Twilio's TTS with **ElevenLabs** for higher-quality voices by routing audio through a custom TTS endpoint.
2. Twilio ConversationRelay supports a `ttsProvider` parameter — setting `ttsProvider=custom` with a `ttsEndpoint` pointing to an ElevenLabs proxy would let the existing WebSocket pipeline remain unchanged.
3. No changes to the agent logic, workers, or composer are needed — TTS is entirely at the Twilio edge.

**Important:** The existing Twilio ConversationRelay WebSocket integration must not be changed. ElevenLabs would be added as a TTS layer only, not replacing the ConversationRelay transport.
