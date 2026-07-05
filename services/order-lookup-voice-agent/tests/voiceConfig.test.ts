import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationRelayVoice, normalizeTwilioElevenLabsModel } from "../src/config.js";

const baseEnv = {
  PUBLIC_BASE_URL: "https://example.com",
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "secret",
  OPENAI_API_KEY: "sk-test",
  SHOPIFY_SHOP_DOMAIN: "shop.myshopify.com",
  SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat",
  VOICE_TTS_PROVIDER: "ElevenLabs",
};

describe("normalizeTwilioElevenLabsModel", () => {
  it("maps eleven_flash_v2_5 to flash_v2_5", () => {
    expect(normalizeTwilioElevenLabsModel("eleven_flash_v2_5")).toBe("flash_v2_5");
  });

  it("maps eleven_turbo_v2_5 to turbo_v2_5", () => {
    expect(normalizeTwilioElevenLabsModel("eleven_turbo_v2_5")).toBe("turbo_v2_5");
  });

  it("passes through Twilio-native slugs unchanged", () => {
    expect(normalizeTwilioElevenLabsModel("flash_v2_5")).toBe("flash_v2_5");
  });
});

describe("conversationRelayVoice", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("builds Twilio voice string without eleven_ prefix", async () => {
    process.env = {
      ...originalEnv,
      ...baseEnv,
      VOICE_ID: "cjVigY5qzO86Huf0OWal",
      VOICE_MODEL: "eleven_flash_v2_5",
      VOICE_TUNING_ENABLED: "false",
    };

    const { conversationRelayVoice: voice } = await import("../src/config.js");
    expect(voice()).toBe("cjVigY5qzO86Huf0OWal-flash_v2_5");
  });

  it("appends formatted tuning for VOICE_SPEED=1 (Twilio requires 1.0 not 1)", async () => {
    process.env = {
      ...originalEnv,
      ...baseEnv,
      VOICE_ID: "cjVigY5qzO86Huf0OWal",
      VOICE_MODEL: "flash_v2_5",
      VOICE_SPEED: "1",
      VOICE_STABILITY: "0.55",
      VOICE_SIMILARITY: "0.8",
      VOICE_TUNING_ENABLED: "true",
    };

    const { conversationRelayVoice: voice } = await import("../src/config.js");
    expect(voice()).toBe("cjVigY5qzO86Huf0OWal-flash_v2_5-1.0_0.55_0.8");
  });

  it("uses default tuning when env vars omitted", async () => {
    process.env = {
      ...originalEnv,
      ...baseEnv,
      VOICE_ID: "voice123",
      VOICE_MODEL: "turbo_v2_5",
      VOICE_TUNING_ENABLED: "true",
    };
    delete process.env.VOICE_SPEED;
    delete process.env.VOICE_STABILITY;
    delete process.env.VOICE_SIMILARITY;

    const { resetConfigCacheForTests, conversationRelayVoice: voice } = await import("../src/config.js");
    resetConfigCacheForTests();
    expect(voice()).toBe("voice123-turbo_v2_5-0.92_0.7_0.85");
  });

  it("skips tuning suffix when VOICE_TUNING_ENABLED=false", async () => {
    process.env = {
      ...originalEnv,
      ...baseEnv,
      VOICE_ID: "voice123",
      VOICE_MODEL: "flash_v2_5",
      VOICE_SPEED: "1",
      VOICE_STABILITY: "0.55",
      VOICE_SIMILARITY: "0.8",
      VOICE_TUNING_ENABLED: "false",
    };

    const { conversationRelayVoice: voice } = await import("../src/config.js");
    expect(voice()).toBe("voice123-flash_v2_5");
  });
});

describe("formatTwilioVoiceTuning", () => {
  it("formats integers with one decimal place", async () => {
    const { formatTwilioVoiceTuning } = await import("../src/config.js");
    expect(formatTwilioVoiceTuning(1, 0.55, 0.8)).toBe("1.0_0.55_0.8");
  });

  it("preserves existing decimals", async () => {
    const { formatTwilioVoiceTuning } = await import("../src/config.js");
    expect(formatTwilioVoiceTuning(0.96, 0.42, 0.78)).toBe("0.96_0.42_0.78");
  });
});
