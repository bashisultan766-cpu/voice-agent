import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCacheForTests } from "../src/config.js";
import {
  normalizeShopifyEnvAliases,
  pingShopifyAdminApi,
  validateShopifyEnvFormat,
} from "../src/platform/envValidator.js";
import { resetShopifyAccessTokenCacheForTests } from "../src/platform/shopifyAccessToken.js";
import { ShopifyAuthError } from "../src/platform/shopifyErrors.js";

const ORIGINAL_ENV = { ...process.env };

describe("envValidator", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      PUBLIC_BASE_URL: "https://test.example.com",
      TWILIO_ACCOUNT_SID: "ACtest",
      TWILIO_AUTH_TOKEN: "test_token",
      OPENAI_API_KEY: "sk-test",
      SHOPIFY_SHOP_DOMAIN: "sureshot-books.myshopify.com",
      SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat_validtoken123456",
      SHOPIFY_API_VERSION: "2024-01",
    };
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
    delete process.env.SHOPIFY_API_KEY;
    delete process.env.SHOPIFY_API_SECRET;
    resetConfigCacheForTests();
    resetShopifyAccessTokenCacheForTests();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.resetModules();
    resetShopifyAccessTokenCacheForTests();
  });

  it("maps SHOPIFY_STORE_DOMAIN alias to SHOPIFY_SHOP_DOMAIN", () => {
    delete process.env.SHOPIFY_SHOP_DOMAIN;
    process.env.SHOPIFY_STORE_DOMAIN = "alias-shop.myshopify.com";
    normalizeShopifyEnvAliases();
    expect(process.env.SHOPIFY_SHOP_DOMAIN).toBe("alias-shop.myshopify.com");
  });

  it("rejects invalid shop domains", () => {
    process.env.SHOPIFY_SHOP_DOMAIN = "not-a-shop.com";
    expect(() => validateShopifyEnvFormat()).toThrow(/SHOPIFY_SHOP_DOMAIN/);
  });

  it("rejects malformed admin tokens", () => {
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "bad-token";
    expect(() => validateShopifyEnvFormat()).toThrow(/SHOPIFY_ADMIN_ACCESS_TOKEN/);
  });

  it("accepts client credentials without static admin token", () => {
    delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    process.env.SHOPIFY_CLIENT_ID = "cid";
    process.env.SHOPIFY_CLIENT_SECRET = "csecret";
    expect(() => validateShopifyEnvFormat()).not.toThrow();
  });

  it("throws ShopifyAuthError on 401 startup ping", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    await expect(pingShopifyAdminApi()).rejects.toBeInstanceOf(ShopifyAuthError);
  });

  it("returns shop name on successful startup ping", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { shop: { name: "SureShot Books" } } }),
    } as Response);

    await expect(pingShopifyAdminApi()).resolves.toBe("SureShot Books");
  });
});
