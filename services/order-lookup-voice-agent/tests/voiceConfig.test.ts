import { afterEach, describe, expect, it, vi } from "vitest";

const baseEnv = {
  PUBLIC_BASE_URL: "https://example.com",
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "secret",
  OPENAI_API_KEY: "sk-test",
  SHOPIFY_SHOP_DOMAIN: "shop.myshopify.com",
  SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat",
  ELEVENLABS_API_KEY: "el-key",
  VOICE_ID: "voice123",
};

describe("elevenlabs config", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("requires ELEVENLABS_API_KEY", async () => {
    process.env = {
      ...originalEnv,
      ...baseEnv,
    };
    delete process.env.ELEVENLABS_API_KEY;

    const { getConfig } = await import("../src/config.js");
    expect(() => getConfig()).toThrow(/ELEVENLABS_API_KEY/);
  });

  it("loads ElevenLabs model and voice settings", async () => {
    process.env = {
      ...originalEnv,
      ...baseEnv,
      ELEVENLABS_MODEL: "eleven_turbo_v2_5",
      VOICE_STABILITY: "0.5",
      VOICE_SIMILARITY: "0.8",
    };

    const { getConfig } = await import("../src/config.js");
    const cfg = getConfig();
    expect(cfg.ELEVENLABS_MODEL).toBe("eleven_turbo_v2_5");
    expect(cfg.VOICE_STABILITY).toBe(0.5);
    expect(cfg.VOICE_SIMILARITY).toBe(0.8);
  });
});
