/**
 * ProtectedOrderCache — tenant-scoped, bounded LRU + TTL cache for raw
 * `OrderStatusResult` payloads.
 *
 * Contract:
 *   - Cache values are the raw Shopify OrderStatusResult (customer PII, tracking,
 *     shipping addresses, notes). This module is the ONLY place raw payloads
 *     may live outside the request path.
 *   - Values are non-loggable: `toJSON` throws and Node's `util.inspect`
 *     custom hook returns "[ProtectedOrderStatus]" so accidental console
 *     output cannot leak PII.
 *   - Keys are always `${tenantId}:${orderNumber}`. `tenantId` defaults to the
 *     Shopify shop domain and cannot be empty.
 *   - Bounded LRU + TTL. When capacity is exceeded the oldest touched entry is
 *     evicted. TTL is enforced on `get` — expired entries are deleted.
 *   - Architecture invariant: this file must only be imported by allow-listed
 *     modules (shopifyService, callerVerificationService, protectedOrderCache
 *     test). Enforced in tests/architectureInvariants.test.ts.
 */
import type { OrderStatusResult } from "../adapters/shopifyStorefrontAdapter.js";
import { getConfig } from "../config.js";

const DEFAULT_MAX_ENTRIES = 256;
const MIN_ENTRIES = 16;

const PROTECTED_INSPECT_MARKER = "[ProtectedOrderStatus]";

/** Standard shape for tenant-scoped cache keys. */
export interface ProtectedOrderCacheKey {
  tenantId: string;
  orderNumber: string;
}

export interface ProtectedOrderCache {
  get(key: ProtectedOrderCacheKey): OrderStatusResult | undefined;
  set(key: ProtectedOrderCacheKey, value: OrderStatusResult): void;
  delete(key: ProtectedOrderCacheKey): boolean;
  clear(tenantId?: string): void;
  /** Test-only visibility. Returns key strings; never leaks values. */
  keys(): string[];
}

interface CacheEntry {
  value: OrderStatusResult;
  expiresAt: number;
}

function normalizeTenantId(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) {
    throw new Error("protectedOrderCache: tenantId must be a non-empty string");
  }
  return trimmed;
}

function normalizeOrderNumber(raw: string | undefined): string {
  const trimmed = (raw ?? "").replace(/^#/, "").trim();
  if (!trimmed) {
    throw new Error("protectedOrderCache: orderNumber must be a non-empty string");
  }
  return trimmed;
}

function makeKey(key: ProtectedOrderCacheKey): string {
  return `${normalizeTenantId(key.tenantId)}:${normalizeOrderNumber(key.orderNumber)}`;
}

/**
 * Wrap the raw OrderStatusResult so accidental `JSON.stringify`, `console.log`,
 * or logger emission cannot leak PII. Only explicit consumers that own the
 * disclosure policy may access `.value`.
 */
function makeProtectedValue(value: OrderStatusResult): OrderStatusResult {
  const clone: OrderStatusResult = { ...value };
  Object.defineProperty(clone, "toJSON", {
    value: () => {
      throw new Error(
        "protectedOrderCache: OrderStatusResult is not serialisable — pass through OrderDisclosurePolicy first",
      );
    },
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(clone, Symbol.for("nodejs.util.inspect.custom"), {
    value: () => PROTECTED_INSPECT_MARKER,
    enumerable: false,
    configurable: false,
  });
  return clone;
}

class LruProtectedOrderCache implements ProtectedOrderCache {
  private readonly store = new Map<string, CacheEntry>();

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {
    if (!Number.isFinite(maxEntries) || maxEntries < MIN_ENTRIES) {
      this.maxEntries = MIN_ENTRIES;
    }
  }

  get(key: ProtectedOrderCacheKey): OrderStatusResult | undefined {
    const composite = makeKey(key);
    const entry = this.store.get(composite);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(composite);
      return undefined;
    }
    // LRU touch — reinsert to bump recency.
    this.store.delete(composite);
    this.store.set(composite, entry);
    return entry.value;
  }

  set(key: ProtectedOrderCacheKey, value: OrderStatusResult): void {
    // Positive hits and invalid format only — never negative not_found.
    if (value.status !== "found" && value.status !== "invalid_format") return;
    const composite = makeKey(key);
    const ttl = Math.max(1, getConfig().SHOPIFY_CACHE_TTL_SECS) * 1000;
    this.store.delete(composite);
    this.store.set(composite, {
      value: makeProtectedValue(value),
      expiresAt: Date.now() + ttl,
    });
    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (typeof oldest === "string") this.store.delete(oldest);
    }
  }

  delete(key: ProtectedOrderCacheKey): boolean {
    return this.store.delete(makeKey(key));
  }

  clear(tenantId?: string): void {
    if (!tenantId) {
      this.store.clear();
      return;
    }
    const prefix = `${normalizeTenantId(tenantId)}:`;
    for (const composite of [...this.store.keys()]) {
      if (composite.startsWith(prefix)) this.store.delete(composite);
    }
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}

const sharedCache: ProtectedOrderCache = new LruProtectedOrderCache();

/** Global protected cache — used by shopifyService. */
export function getProtectedOrderCache(): ProtectedOrderCache {
  return sharedCache;
}

/** Reset — test hook only. */
export function resetProtectedOrderCacheForTests(): void {
  (sharedCache as LruProtectedOrderCache).clear();
}

/** Best-effort tenant identifier from the current runtime config. */
export function tenantIdForCurrentShop(): string {
  const cfg = getConfig();
  return normalizeTenantId(cfg.SHOPIFY_SHOP_DOMAIN);
}

export const __TEST_ONLY__ = {
  PROTECTED_INSPECT_MARKER,
  LruProtectedOrderCache,
};
