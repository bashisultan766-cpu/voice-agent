import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCacheForTests } from "../src/config.js";
import {
  getShopifyAdminAccessToken,
  resetShopifyAccessTokenCacheForTests,
} from "../src/platform/shopifyAccessToken.js";

const ORIGINAL_ENV = { ...process.env };

describe("shopifyAccessToken", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      PUBLIC_BASE_URL: "https://test.example.com",
      TWILIO_ACCOUNT_SID: "ACtest",
      TWILIO_AUTH_TOKEN: "test_token",
      OPENAI_API_KEY: "sk-test",
      SHOPIFY_SHOP_DOMAIN: "sureshot-books.myshopify.com",
      SHOPIFY_API_VERSION: "2024-01",
      SHOPIFY_TIMEOUT_MS: "5000",
    };
    delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
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
    resetShopifyAccessTokenCacheForTests();
    resetConfigCacheForTests();
  });

  it("returns static admin token when client credentials are unset", async () => {
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "shpat_staticfallbacktoken99";
    resetConfigCacheForTests();

    await expect(getShopifyAdminAccessToken()).resolves.toBe("shpat_staticfallbacktoken99");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches and caches client credentials token", async () => {
    process.env.SHOPIFY_CLIENT_ID = "client-id";
    process.env.SHOPIFY_CLIENT_SECRET = "client-secret";
    resetConfigCacheForTests();

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: "shpat_dynamic_token_abc",
          expires_in: 86399,
          scope: "read_orders",
        }),
    } as Response);

    const first = await getShopifyAdminAccessToken();
    const second = await getShopifyAdminAccessToken();

    expect(first).toBe("shpat_dynamic_token_abc");
    expect(second).toBe("shpat_dynamic_token_abc");
    expect(fetch).toHaveBeenCalledTimes(1);

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toBe(
      "https://sureshot-books.myshopify.com/admin/oauth/access_token",
    );
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain("grant_type=client_credentials");
    expect(String(init?.body)).toContain("client_secret=client-secret");
  });

  it("surfaces HTTP status on failed client credentials handshake", async () => {
    process.env.SHOPIFY_CLIENT_ID = "client-id";
    process.env.SHOPIFY_CLIENT_SECRET = "client-secret";
    resetConfigCacheForTests();

    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({
          error: "invalid_client",
          error_description: "Client authentication failed",
        }),
    } as Response);

    await expect(getShopifyAdminAccessToken()).rejects.toThrow(
      /shopify_client_credentials_http_401/,
    );
  });
});
