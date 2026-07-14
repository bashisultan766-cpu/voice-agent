/**
 * ProtectedOrderCache invariants — tenant isolation, TTL, eviction, invalid
 * key rejection, and serialization safety. These tests plant synthetic PII in
 * the cache and assert it never escapes through JSON or console output.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __TEST_ONLY__ } from "../src/infra/protectedOrderCache.js";
import type { OrderStatusResult } from "../src/adapters/shopifyStorefrontAdapter.js";

// Provide a config double so the LRU picks up SHOPIFY_CACHE_TTL_SECS.
vi.mock("../src/config.ts", async () => {
  return {
    getConfig: () => ({ SHOPIFY_CACHE_TTL_SECS: 60, SHOPIFY_SHOP_DOMAIN: "sureshot.myshopify.com" }),
  };
});

const { LruProtectedOrderCache, PROTECTED_INSPECT_MARKER } = __TEST_ONLY__;

function orderFound(overrides: Partial<OrderStatusResult> = {}): OrderStatusResult {
  return {
    status: "found",
    orderNumber: overrides.orderNumber ?? "1001",
    customerName: "Alex Doe",
    customerEmail: "alex@example.com",
    customerPhone: "+15555550000",
    ...overrides,
  } as OrderStatusResult;
}

describe("ProtectedOrderCache", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("scopes entries by tenantId — one tenant cannot read another's order", () => {
    const cache = new LruProtectedOrderCache();
    cache.set({ tenantId: "shop-a.myshopify.com", orderNumber: "1001" }, orderFound({ orderNumber: "1001" }));
    cache.set({ tenantId: "shop-b.myshopify.com", orderNumber: "1001" }, orderFound({ orderNumber: "1001" }));
    const a = cache.get({ tenantId: "shop-a.myshopify.com", orderNumber: "1001" });
    const b = cache.get({ tenantId: "shop-b.myshopify.com", orderNumber: "1001" });
    expect(a?.customerName).toBe("Alex Doe");
    expect(b?.customerName).toBe("Alex Doe");
    expect(cache.keys().sort()).toEqual([
      "shop-a.myshopify.com:1001",
      "shop-b.myshopify.com:1001",
    ]);
  });

  it("clear(tenantId) removes only that tenant's entries", () => {
    const cache = new LruProtectedOrderCache();
    cache.set({ tenantId: "shop-a", orderNumber: "1" }, orderFound());
    cache.set({ tenantId: "shop-b", orderNumber: "2" }, orderFound({ orderNumber: "2" }));
    cache.clear("shop-a");
    expect(cache.get({ tenantId: "shop-a", orderNumber: "1" })).toBeUndefined();
    expect(cache.get({ tenantId: "shop-b", orderNumber: "2" })).toBeDefined();
  });

  it("rejects empty tenantId and empty orderNumber", () => {
    const cache = new LruProtectedOrderCache();
    expect(() => cache.set({ tenantId: "", orderNumber: "1" }, orderFound())).toThrow();
    expect(() => cache.set({ tenantId: "shop-a", orderNumber: "" }, orderFound())).toThrow();
    expect(() => cache.get({ tenantId: "", orderNumber: "1" })).toThrow();
  });

  it("does not cache non-found / non-invalid_format statuses", () => {
    const cache = new LruProtectedOrderCache();
    cache.set(
      { tenantId: "shop-a", orderNumber: "1" },
      { status: "not_found" } as OrderStatusResult,
    );
    expect(cache.get({ tenantId: "shop-a", orderNumber: "1" })).toBeUndefined();
    cache.set(
      { tenantId: "shop-a", orderNumber: "2" },
      { status: "api_error", message: "boom" } as OrderStatusResult,
    );
    expect(cache.get({ tenantId: "shop-a", orderNumber: "2" })).toBeUndefined();
  });

  it("respects TTL: expired entries return undefined", () => {
    vi.useFakeTimers();
    const cache = new LruProtectedOrderCache();
    cache.set({ tenantId: "shop-a", orderNumber: "1" }, orderFound());
    // Config TTL is 60s; advance beyond that.
    vi.advanceTimersByTime(61_000);
    expect(cache.get({ tenantId: "shop-a", orderNumber: "1" })).toBeUndefined();
  });

  it("evicts oldest entry when capacity is exceeded", () => {
    const cache = new LruProtectedOrderCache(16);
    for (let i = 0; i < 32; i += 1) {
      cache.set({ tenantId: "shop-a", orderNumber: String(i) }, orderFound({ orderNumber: String(i) }));
    }
    expect(cache.keys().length).toBeLessThanOrEqual(16);
    // Order 0 (oldest) is gone; order 31 (newest) remains.
    expect(cache.get({ tenantId: "shop-a", orderNumber: "0" })).toBeUndefined();
    expect(cache.get({ tenantId: "shop-a", orderNumber: "31" })).toBeDefined();
  });

  it("cached values throw when JSON.stringify is attempted", () => {
    const cache = new LruProtectedOrderCache();
    cache.set({ tenantId: "shop-a", orderNumber: "1" }, orderFound());
    const value = cache.get({ tenantId: "shop-a", orderNumber: "1" });
    expect(value).toBeDefined();
    expect(() => JSON.stringify(value)).toThrow(/not serialisable|OrderDisclosurePolicy/);
  });

  it("cached values expose util.inspect marker so console.log does not leak", () => {
    const cache = new LruProtectedOrderCache();
    cache.set({ tenantId: "shop-a", orderNumber: "1" }, orderFound());
    const value = cache.get({ tenantId: "shop-a", orderNumber: "1" }) as Record<
      symbol,
      () => unknown
    >;
    const inspect = value[Symbol.for("nodejs.util.inspect.custom")];
    expect(typeof inspect).toBe("function");
    expect(inspect()).toBe(PROTECTED_INSPECT_MARKER);
  });

  it("normalises order number prefix (#) and trims whitespace", () => {
    const cache = new LruProtectedOrderCache();
    cache.set({ tenantId: "shop-a", orderNumber: " 1001 " }, orderFound());
    expect(cache.get({ tenantId: "SHOP-A", orderNumber: "#1001" })).toBeDefined();
  });
});
