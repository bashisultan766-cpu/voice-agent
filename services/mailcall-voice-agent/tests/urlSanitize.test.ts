import { describe, expect, it, beforeEach } from "vitest";
import {
  sanitizeHttpUrl,
  sanitizeOptionalHttpUrl,
  loadRuntimeConfig,
  resetConfigCache,
} from "../src/config.js";

describe("sanitizeHttpUrl", () => {
  it("trims whitespace and control chars from VPS copy-paste", () => {
    expect(sanitizeHttpUrl("  https://mailcall.example/\r\n")).toBe("https://mailcall.example/");
    expect(sanitizeHttpUrl("\thttps://mailcall.example\t")).toBe("https://mailcall.example");
  });

  it("prepends https:// when scheme is missing", () => {
    expect(sanitizeHttpUrl("mailcall.example")).toBe("https://mailcall.example");
    expect(sanitizeHttpUrl("www.mailcall.example/path")).toBe("https://www.mailcall.example/path");
  });

  it("preserves http and https schemes", () => {
    expect(sanitizeHttpUrl("http://mailcall.example")).toBe("http://mailcall.example");
    expect(sanitizeHttpUrl("https://mailcall.example")).toBe("https://mailcall.example");
  });
});

describe("loadRuntimeConfig self-heal", () => {
  beforeEach(() => {
    resetConfigCache();
  });

  it("accepts bare domain MAILCALL_WP_URL after https prepend", () => {
    const state = loadRuntimeConfig({
      MAILCALL_TWILIO_PHONE_NUMBER: "+15551234567",
      MAILCALL_WP_URL: "  mailcall.example  ",
      MAILCALL_WP_USER: "editor",
      MAILCALL_WP_APP_PASSWORD: "abcdefghijklmnopqrstuvwx",
    });

    expect(state.degraded).toBe(false);
    expect(state.config.wpBaseUrl).toBe("https://mailcall.example");
    expect(state.config.MAILCALL_PORT).toBe(8010);
  });

  it("boots degraded instead of fatal when URL remains unusable", () => {
    const state = loadRuntimeConfig({
      MAILCALL_TWILIO_PHONE_NUMBER: "+15551234567",
      MAILCALL_WP_URL: "://bad",
      MAILCALL_WP_USER: "editor",
      MAILCALL_WP_APP_PASSWORD: "abcdefghijklmnopqrstuvwx",
    });

    expect(state.degraded).toBe(true);
    expect(state.degradeReasons.length).toBeGreaterThan(0);
    expect(state.config.MAILCALL_PORT).toBe(8010);
  });

  it("sanitizeOptionalHttpUrl returns undefined for empty", () => {
    expect(sanitizeOptionalHttpUrl("")).toBeUndefined();
    expect(sanitizeOptionalHttpUrl("  ")).toBeUndefined();
  });
});
