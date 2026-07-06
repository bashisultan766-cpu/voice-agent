/**
 * Cross-call in-memory cache — survives dropped calls within the same Node process.
 */
import type { ShoppingCartLineItem } from "../types/order.js";
import { logger } from "./logger.js";

export const CALLER_WELCOME_BACK_GREETING =
  "Hey there, welcome back! Let's continue from where we left off.";

export const SURESHOT_GOODBYE_SPEECH =
  "Thank you for choosing SureShot Books. Have a wonderful day!";

/** Retain dropped-call context for one calendar day. */
const TTL_MS = 24 * 60 * 60 * 1000;

export interface CallerMemorySnapshot {
  phone: string;
  lastIntent?: string;
  shoppingCart?: ShoppingCartLineItem[];
  currentOrderData?: Record<string, unknown>;
  savedAt: number;
}

const callerCache = new Map<string, CallerMemorySnapshot>();

export function normalizeCallerCacheKey(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits || phone.trim();
}

function pruneExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of callerCache) {
    if (now - entry.savedAt > TTL_MS) {
      callerCache.delete(key);
    }
  }
}

export function saveCallerMemory(
  snapshot: Omit<CallerMemorySnapshot, "savedAt">,
): void {
  pruneExpiredEntries();
  const key = normalizeCallerCacheKey(snapshot.phone);
  if (!key) return;
  callerCache.set(key, { ...snapshot, savedAt: Date.now() });
  logger.info("caller_memory_saved", {
    keySuffix: key.slice(-4),
    cartLines: snapshot.shoppingCart?.length ?? 0,
    hasOrderContext: Boolean(snapshot.currentOrderData),
  });
}

export function getCallerMemory(phone: string): CallerMemorySnapshot | undefined {
  pruneExpiredEntries();
  const key = normalizeCallerCacheKey(phone);
  const entry = callerCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.savedAt > TTL_MS) {
    callerCache.delete(key);
    return undefined;
  }
  return entry;
}

export function clearCallerMemory(phone: string): void {
  const key = normalizeCallerCacheKey(phone);
  if (key) callerCache.delete(key);
}

export function buildCallerWelcomeBackSystemMessage(): string {
  return (
    "CRITICAL INSTRUCTION: The user's previous call dropped recently. " +
    `You MUST open the conversation by saying exactly: '${CALLER_WELCOME_BACK_GREETING}' ` +
    "Do not ask for their name again."
  );
}
