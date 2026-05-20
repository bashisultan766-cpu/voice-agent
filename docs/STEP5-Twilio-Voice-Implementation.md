# Step 5 — Twilio Voice Inbound + Agent Routing + Voice Runtime Skeleton

**Scope:** Customer calls Twilio number → system identifies agent → CallSession created → TwiML with Stream/ConversationRelay → voice runtime skeleton (greeting, session context, transcript buffer). Full OpenAI/tool loop in Step 6.

---

## 1. What Was Implemented

### 1.1 Prisma

- **CallSession:** `twilioStreamSid`, `direction`, `answeredAt`, `lastEventAt`, `metadata`
- **CallTranscript:** `timestampMs`

Run: `pnpm --filter api prisma migrate dev --name step5_call_session_runtime`

### 1.2 Twilio Module (`apps/api/src/modules/integrations/twilio/`)

| File | Purpose |
|------|--------|
| `twilio.module.ts` | Registers controller and services |
| `twilio.controller.ts` | POST `/api/twilio/voice/inbound`, POST `/api/twilio/voice/status` |
| `twilio-signature.service.ts` | Validates `X-Twilio-Signature` |
| `twilio-webhook.service.ts` | Resolve agent by To number → create CallSession → return TwiML |
| `agent-resolution.service.ts` | Phone number → PhoneNumber record → Agent + Store (active only) |
| `twiml/conversation-relay.twiml.ts` | `<Response><Connect><Stream url="wss://..."/></Connect></Response>` and fallback TwiML |
| `utils/normalize-phone.ts` | E.164-style normalize for lookup |

### 1.3 Calls Module Extensions

- **CallsService:** `createSession()`, `updateSessionStatus()`, `updateSessionByTwilioCallSid()`
- **Runtime** (`calls/runtime/`):
  - `session-context.service.ts` — load `VoiceSessionContext` by `callSessionId`
  - `voice-runtime.service.ts` — greeting, system prompt assembly, `onRuntimeConnected` / `onRuntimeDisconnected`, `processUtterance` placeholder
  - `voice-runtime.controller.ts` — GET `/api/calls/runtime/greeting?callSessionId=`, GET `/api/calls/runtime/session/:callSessionId/context`
  - `transcript-buffer.service.ts` — append transcript chunks (user/agent/system/tool)

### 1.4 Main

- `express.urlencoded({ extended: false })` for Twilio form-urlencoded webhook body.

---

## 2. End-to-End Flow

1. Customer calls Twilio number.
2. Twilio POST to `PUBLIC_WEBHOOK_BASE_URL/api/twilio/voice/inbound` with `CallSid`, `From`, `To`, etc.
3. Backend validates signature, normalizes `To`, finds `PhoneNumber` → Agent (active) → Store.
4. Backend creates `CallSession` (INITIATED, startedAt, twilioCallSid, from/to, direction=inbound).
5. Backend returns TwiML with `<Connect><Stream url="wss://...?callSessionId=..."/></Connect>`.
6. Twilio connects to WebSocket (Step 5 provides HTTP placeholder for context/greeting; actual WS in next step).
7. Runtime loads session context, returns greeting; on disconnect updates CallSession (COMPLETED, endedAt, duration).

---

## 3. Env Variables (Step 5)

```env
# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

# Webhook base URL (must be HTTPS in production; Twilio needs public URL)
PUBLIC_WEBHOOK_BASE_URL=https://your-api.example.com
PUBLIC_WS_BASE_URL=wss://your-api.example.com
```

Optional later: `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_TWIML_APP_SID`.

---

## 4. Twilio Console Setup

1. Phone number → Configure → Voice & Fax.
2. A call comes in: **Webhook** → `https://your-api.example.com/api/twilio/voice/inbound`, HTTP POST.
3. (Optional) Status callback: `https://your-api.example.com/api/twilio/voice/status`.

---

## 5. Testing Without a Real Call

- **Agent resolution:** Ensure a `PhoneNumber` row with `phoneNumber` (E.164), `status=ACTIVE`, `agentId` set; agent `status=ACTIVE`, store active.
- **Inbound webhook:** Use Twilio’s “Test your webhook” or a tool (e.g. Postman) with form-body `CallSid`, `From`, `To` and valid `X-Twilio-Signature` (or temporarily skip validation in dev).
- **Runtime context:** `GET /api/calls/runtime/greeting?callSessionId=<id>` and `GET /api/calls/runtime/session/:callSessionId/context` after creating a call session.

---

## 6. Implementation Order Used

1. Prisma schema update (CallSession, CallTranscript).
2. Twilio module: signature service, normalize-phone, agent-resolution, TwiML builder.
3. CallsService: createSession, updateSessionStatus.
4. Twilio webhook service and controller.
5. Calls runtime: SessionContextService, VoiceRuntimeService, TranscriptBufferService, VoiceRuntimeController.
6. IntegrationsModule imports TwilioModule; main.ts urlencoded middleware.

---

## 7. What’s Next (Step 6)

- WebSocket gateway for Twilio Media Streams / ConversationRelay.
- OpenAI Realtime (or equivalent) for speech-to-speech.
- Tool-calling loop (Shopify tools).
- Transcript flush on disconnect.
- Fallback and escalation handling.

---

## 8. Cursor Prompts (Reference)

- **Twilio inbound:** “Generate Twilio voice webhook module: POST /api/twilio/voice/inbound, signature validation, agent resolution by To number, CallSession create, TwiML with Connect/Stream.”
- **Agent resolution:** “Generate AgentResolutionService: input To number, normalize, find PhoneNumber with active Agent and Store, return tenant/store/agent context.”
- **Voice runtime:** “Generate voice runtime skeleton: SessionContextService (load by callSessionId), VoiceRuntimeService (greeting, system prompt, onConnected/onDisconnected), TranscriptBufferService, HTTP endpoints for context and greeting.”
