import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationRelayVoice, normalizeTwilioElevenLabsModel } from "../src/config.js";

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
    process.env.PUBLIC_BASE_URL = "https://example.com";
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "secret";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.SHOPIFY_SHOP_DOMAIN = "shop.myshopify.com";
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "shpat";
    process.env.VOICE_TTS_PROVIDER = "ElevenLabs";
    process.env.VOICE_ID = "cjVigY5qzO86Huf0OWal";
    process.env.VOICE_MODEL = "eleven_flash_v2_5";

    const { conversationRelayVoice: voice } = await import("../src/config.js");
    expect(voice()).toBe("cjVigY5qzO86Huf0OWal-flash_v2_5");
  });

  it("ignores VOICE_SPEED/STABILITY/SIMILARITY for Twilio TwiML voice", async () => {
    process.env.PUBLIC_BASE_URL = "https://example.com";
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "secret";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.SHOPIFY_SHOP_DOMAIN = "shop.myshopify.com";
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "shpat";
    process.env.VOICE_TTS_PROVIDER = "ElevenLabs";
    process.env.VOICE_ID = "cjVigY5qzO86Huf0OWal";
    process.env.VOICE_MODEL = "flash_v2_5";
    process.env.VOICE_SPEED = "1";
    process.env.VOICE_STABILITY = "0.55";
    process.env.VOICE_SIMILARITY = "0.8";

    const { conversationRelayVoice: voice } = await import("../src/config.js");
    expect(voice()).toBe("cjVigY5qzO86Huf0OWal-flash_v2_5");
  });
});

describe("formatTwilioVoiceTuning", () => {
  it("formats integers with one decimal place", async () => {
    const { formatTwilioVoiceTuning } = await import("../src/config.js");
    expect(formatTwilioVoiceTuning(1, 0.55, 0.8)).toBe("1.0_0.55_0.8");
  });
});
