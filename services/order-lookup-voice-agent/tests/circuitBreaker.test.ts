import { beforeEach, describe, expect, it } from "vitest";
import {
  getShopifyCircuitSnapshot,
  isShopifyCircuitOpen,
  recordShopifyThrottle,
  resetShopifyCircuitBreaker,
  withShopifyCircuitBreaker,
} from "../src/platform/circuitBreaker.js";
import { ShopifyThrottledError } from "../src/platform/shopifyErrors.js";
import { parseShopifyGraphqlErrors } from "../src/platform/shopifyErrors.js";

describe("shopifyErrors", () => {
  it("detects extensions.code THROTTLED", () => {
    const err = parseShopifyGraphqlErrors([
      { message: "Throttled", extensions: { code: "THROTTLED" } },
    ]);
    expect(err).toBeInstanceOf(ShopifyThrottledError);
  });
});

describe("circuitBreaker", () => {
  beforeEach(() => {
    resetShopifyCircuitBreaker();
  });

  it("opens immediately on THROTTLED", async () => {
    await expect(
      withShopifyCircuitBreaker("CA_1", "isbn_search", async () => {
        throw new ShopifyThrottledError();
      }),
    ).rejects.toBeInstanceOf(ShopifyThrottledError);

    expect(isShopifyCircuitOpen()).toBe(true);
    expect(getShopifyCircuitSnapshot().openCycle).toBe(1);
  });

  it("short-circuits calls while OPEN", async () => {
    recordShopifyThrottle(new ShopifyThrottledError());
    await expect(
      withShopifyCircuitBreaker("CA_2", "isbn_search", async () => []),
    ).rejects.toMatchObject({ name: "ShopifyCircuitOpenError" });
  });
});
