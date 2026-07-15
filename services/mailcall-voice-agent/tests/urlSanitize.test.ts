import { describe, expect, it, beforeEach } from "vitest";
import {
  sanitizeHttpUrl,
  sanitizeOptionalHttpUrl,
  loadRuntimeConfig,
  resetConfigCache,
} from "../src/config.js";

describe("sanitizeHttpUrl", () => {
  it("trims whitespace, control chars, and trailing slashes from VPS copy-paste", () => {
    expect(sanitizeHttpUrl("  https://mailcallnewspaper.com/\r\n")).toBe(
      "https://mailcallnewspaper.com",
    );
    expect(sanitizeHttpUrl("\thttps://mailcallnewspaper.com///\t")).toBe(
      "https://mailcallnewspaper.com",
    );
    expect(sanitizeHttpUrl("\thttps://agent.mailcallcommunication.com/\t")).toBe(
      "https://agent.mailcallcommunication.com",
    );
  });

  it("prepends https:// when scheme is missing", () => {
    expect(sanitizeHttpUrl("mailcallnewspaper.com")).toBe("https://mailcallnewspaper.com");
    expect(sanitizeHttpUrl("www.mailcall.example/path")).toBe("https://www.mailcall.example/path");
  });

  it("preserves http and https schemes", () => {
    expect(sanitizeHttpUrl("http://mailcall.example")).toBe("http://mailcall.example");
    expect(sanitizeHttpUrl("https://mailcallnewspaper.com")).toBe("https://mailcallnewspaper.com");
  });
});

describe("loadRuntimeConfig self-heal", () => {
  beforeEach(() => {
    resetConfigCache();
  });

  it("accepts bare domain MAILCALL_WP_URL after https prepend and slash trim", () => {
    const state = loadRuntimeConfig({
      MAILCALL_TWILIO_PHONE_NUMBER: "+15551234567",
      MAILCALL_WP_URL: "  mailcallnewspaper.com/  ",
      MAILCALL_WP_USER: "editor",
      MAILCALL_WP_APP_PASSWORD: "abcdefghijklmnopqrstuvwx",
      MAILCALL_PUBLIC_BASE_URL: "https://agent.mailcallcommunication.com/",
    });

    expect(state.degraded).toBe(false);
    expect(state.config.wpBaseUrl).toBe("https://mailcallnewspaper.com");
    expect(state.config.MAILCALL_PUBLIC_BASE_URL).toBe(
      "https://agent.mailcallcommunication.com",
    );
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
