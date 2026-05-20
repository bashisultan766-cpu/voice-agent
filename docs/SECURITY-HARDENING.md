# Security Hardening Notes

This document summarizes the key security guardrails implemented after initial feature work.

## 1. Rate limiting for sensitive Shopify routes

To reduce abuse of OAuth/connection lifecycle endpoints, we added NestJS throttling on `apps/api/src/modules/integrations/shopify/shopify.controller.ts`:
- Controller default: `60 req/min`
- `oauth/start`: `20 req/min`
- `disconnect`: `15 req/min`

Webhook endpoints remain explicitly public and may be exempted from throttling to avoid breaking Shopify delivery retries.

## 2. Stricter credential validation for “test connection” endpoints

Connection-test DTOs now enforce tighter validation in:
- `apps/api/src/modules/agents/dto/test-connection.dto.ts`

Examples:
- Shopify store URL must be `*.myshopify.com`
- Twilio `Account SID` format validation
- Minimum lengths for OpenAI / ElevenLabs API keys

This prevents obviously invalid input from reaching external calls and makes UX errors clearer.

## 3. Redaction-safe logging for secrets

Added a reusable redaction helper that masks sensitive fields before logging:
- `apps/api/src/common/logging/safe-log.ts`

Sensitive keys matched include (case-insensitive): `token`, `secret`, `password`, `authorization`, `apiKey`, `accessKey`, `privateKey`.

Used in:
- Shopify webhook controller: invalid signature + processing failures
- Twilio voice controller: invalid signature failures

## 4. Raw-body requirement for Shopify webhook signature validation

Shopify HMAC verification requires the exact raw request body bytes.
We updated:
- `apps/api/src/main.ts`

to attach `express.raw()` specifically for:
- `/api/integrations/shopify/webhooks`

## Verification

- `pnpm --filter api typecheck` ✅
- `pnpm --filter web typecheck` ✅

