/**
 * Disclosure-safe session serialization.
 * Every path that persists a session to L2 (Postgres, disk, log meta) MUST
 * route through `serializeSessionForPersistence` or call
 * `assertSessionSafeForPersistence` first. If a protected marker or raw
 * Shopify shape is present anywhere in the object graph we throw immediately
 * so unauthorized data can never escape process memory.
 */
import type { CallSession } from "../types/order.js";

/** Keys / shape markers that indicate a raw Shopify / vault payload. */
const PROTECTED_KEY_MARKERS = new Set([
  "admin_graphql_api_id",
  "adminGraphqlApiId",
  "__rawShopify",
  "__rawOrderStatus",
  "rawOrderStatus",
  "lastOrderStatusResult",
]);

/**
 * Raw Shopify OrderStatusResult has this signature (adapter status +
 * `orderNumber`) — reject any object at any depth that both fields.
 */
function looksLikeRawOrderStatusResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  const hasStatus =
    typeof obj.status === "string" &&
    ["found", "not_found", "invalid_format", "api_error", "system_maintenance", "throttled"].includes(
      String(obj.status),
    );
  const hasOrderNumber = typeof obj.orderNumber === "string" && obj.orderNumber.length > 0;
  const hasLineItems = Array.isArray(obj.lineItems);
  const hasCustomer =
    typeof obj.customerEmail === "string" || typeof obj.customerPhone === "string";
  // A shaped snake_case payload uses `order_number`, not `orderNumber` +
  // `lineItems`. Require BOTH raw-camelCase hallmarks before flagging.
  return hasStatus && hasOrderNumber && (hasLineItems || hasCustomer);
}

/** Deep scan — throws when a protected shape or key marker is present. */
export function assertSessionSafeForPersistence(session: CallSession | unknown): void {
  const seen = new WeakSet<object>();

  function visit(node: unknown, path: string): void {
    if (node == null) return;
    if (typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);

    if (looksLikeRawOrderStatusResult(node)) {
      throw new Error(
        `sessionSerialization: raw OrderStatusResult-shaped payload detected at ${path || "$"} — refuse to persist.`,
      );
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        visit(node[i], `${path}[${i}]`);
      }
      return;
    }

    const entries = Object.entries(node as Record<string, unknown>);
    for (const [key, value] of entries) {
      if (PROTECTED_KEY_MARKERS.has(key)) {
        throw new Error(
          `sessionSerialization: protected marker key "${key}" detected at ${path || "$"}.${key} — refuse to persist.`,
        );
      }
      visit(value, `${path ? `${path}.${key}` : key}`);
    }
    if (path === "currentOrderData" && entries.length > 0) {
      throw new Error(
        "sessionSerialization: legacy currentOrderData is not persistable; use sessionOrderContext.orderView.",
      );
    }
  }

  visit(session, "");
}

/** JSON string with the safety assertion applied first. */
export function serializeSessionForPersistence(session: CallSession): string {
  assertSessionSafeForPersistence(session);
  // Clone + redact sticky OrderView secrets that must not land in L2 JSONB.
  // In-memory session may retain tracking digits for notepad dictation; the
  // durable snapshot only keeps `tracking_available`.
  const clone = structuredClone(session) as CallSession;
  const view = clone.sessionOrderContext?.orderView as Record<string, unknown> | undefined;
  if (view) {
    const hadTracking = Boolean(view.tracking_number || view.tracking_number_for_tts || view.tracking_available);
    delete view.tracking_number;
    delete view.tracking_number_for_tts;
    delete view.customer_phone;
    if (hadTracking) view.tracking_available = true;
  }
  // Challenge secrets stay process-local — never persist expected zip/street to L2.
  const mem = clone.sessionMemory as Record<string, unknown> | undefined;
  if (mem) {
    delete mem.expectedZipCode;
    delete mem.expectedPoBoxOrStreet;
  }
  return JSON.stringify(clone);
}

/** True when the session is safe to persist (does not throw). */
export function isSessionSafeForPersistence(session: CallSession | unknown): boolean {
  try {
    assertSessionSafeForPersistence(session);
    return true;
  } catch {
    return false;
  }
}
