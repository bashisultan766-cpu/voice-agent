/**
 * Recursive trace redaction for structured logs, pipeline traces, and staging
 * capture. This module is the single source of truth for what can and cannot
 * leave the process in a log or persisted trace.
 *
 * Redacted:
 *   - phone numbers (E.164 or free-form)
 *   - email addresses
 *   - shipping / billing addresses
 *   - tracking numbers
 *   - Shopify customer IDs / GIDs
 *   - order notes / customer notes
 *   - raw Shopify OrderStatusResult-shaped payloads
 *   - invoice URLs
 *   - payment tokens / draft-order tokens
 *
 * Non-goals: this is defence-in-depth. The primary controls remain
 * `sessionSerialization` (persistence) and `ProtectedOrderCache` (in-memory).
 */

const REDACTED = "[redacted]";

const PROTECTED_KEY_PATTERNS: Array<RegExp> = [
  /(^|_)phone($|_)/i,
  /(^|_)email($|_)/i,
  /(^|_)address($|_)/i,
  /(^|_)shipping_address($|_)/i,
  /(^|_)billing_address($|_)/i,
  /(^|_)tracking_number($|_)/i,
  /(^|_)tracking_id($|_)/i,
  /(^|_)tracking_for_tts($|_)/i,
  /(^|_)customer_id($|_)/i,
  /(^|_)shopify_customer_id($|_)/i,
  /(^|_)admin_graphql_api_id($|_)/i,
  /(^|_)order_notes?($|_)/i,
  /(^|_)note_attributes($|_)/i,
  /(^|_)note$/i,
  /(^|_)invoice_url($|_)/i,
  /(^|_)payment_token($|_)/i,
  /(^|_)payment_link($|_)/i,
  /(^|_)draft_order_token($|_)/i,
  /(^|_)authorization($|_)/i,
  /(^|_)api.?key($|_)/i,
  /(^|_)secret($|_)/i,
  /(^|_)access.?token($|_)/i,
];

const PHONE_RE = /\b(?:\+?\d[\d\s\-().]{6,}\d)\b/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const TRACKING_ID_RE = /\b[0-9]{10,}\b|\b1Z[0-9A-Z]{16}\b/g;
const SHOPIFY_GID_RE = /gid:\/\/shopify\/(?:Customer|Order|DraftOrder)\/\d+/g;
const INVOICE_URL_RE = /https?:\/\/[^\s"']*(?:checkout|invoice|invoices)[^\s"']*/gi;

function isProtectedKey(key: string): boolean {
  return PROTECTED_KEY_PATTERNS.some((re) => re.test(key));
}

function redactString(input: string): string {
  return input
    .replace(EMAIL_RE, REDACTED)
    .replace(INVOICE_URL_RE, REDACTED)
    .replace(SHOPIFY_GID_RE, REDACTED)
    .replace(TRACKING_ID_RE, REDACTED)
    .replace(PHONE_RE, (match) => {
      const digits = match.replace(/\D/g, "");
      return digits.length >= 7 ? REDACTED : match;
    });
}

function looksLikeRawOrderStatus(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  const hasStatus =
    typeof obj.status === "string" &&
    ["found", "not_found", "invalid_format", "api_error", "system_maintenance", "throttled"].includes(
      String(obj.status),
    );
  const hasOrderNumber = typeof obj.orderNumber === "string";
  const hasCustomer =
    typeof obj.customerEmail === "string" ||
    typeof obj.customerPhone === "string" ||
    Array.isArray(obj.lineItems);
  return hasStatus && hasOrderNumber && hasCustomer;
}

/**
 * Recursively redact sensitive values. Returns a new object graph — the input
 * is never mutated.
 */
export function redactSensitive(value: unknown): unknown {
  return visit(value, new WeakSet());
}

function visit(value: unknown, seen: WeakSet<object>): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }
  if (typeof value !== "object") return REDACTED;

  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (looksLikeRawOrderStatus(value)) {
    return { redacted: "raw_order_status_result" };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => visit(entry, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isProtectedKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = visit(entry, seen);
  }
  return out;
}

/**
 * Sanitize logger meta — replaces logger.sanitizeMeta so protected keys are
 * consistently redacted before the log line is serialized.
 */
export function sanitizeLoggerMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const result = redactSensitive(meta);
  return (result && typeof result === "object" && !Array.isArray(result))
    ? (result as Record<string, unknown>)
    : {};
}

/**
 * Attach a redacted trace payload to a staging capture. Returns a JSON-safe
 * object that includes the correlation ids the ops team keys on so incidents
 * can be reconstructed without inspecting protected data.
 */
export interface CaptureTraceInput {
  callId?: string;
  turnId?: string;
  workflowId?: string;
  checkoutPlanId?: string;
  checkoutGroupId?: string;
  operationId?: string;
  idempotencyKey?: string;
  requestId?: string;
  event: string;
  payload?: unknown;
}

export interface CapturedTrace {
  callId?: string;
  turnId?: string;
  workflowId?: string;
  checkoutPlanId?: string;
  checkoutGroupId?: string;
  operationId?: string;
  idempotencyKey?: string;
  requestId?: string;
  event: string;
  redactedPayload: unknown;
  capturedAt: string;
}

export function captureTrace(input: CaptureTraceInput): CapturedTrace {
  return {
    callId: input.callId,
    turnId: input.turnId,
    workflowId: input.workflowId,
    checkoutPlanId: input.checkoutPlanId,
    checkoutGroupId: input.checkoutGroupId,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    event: input.event,
    redactedPayload: redactSensitive(input.payload ?? null),
    capturedAt: new Date().toISOString(),
  };
}
