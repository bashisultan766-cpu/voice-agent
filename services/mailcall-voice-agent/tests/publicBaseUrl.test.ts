import { describe, expect, it, beforeEach } from "vitest";
import type { Request } from "express";
import { resolvePublicBaseUrl } from "../src/agents/mailcall/router.js";
import { resetConfigCache, type MailCallConfig } from "../src/config.js";

function cfg(partial: Partial<MailCallConfig> = {}): MailCallConfig {
  return {
    MAILCALL_PUBLIC_BASE_URL: undefined,
    MAILCALL_TWILIO_PHONE_NUMBER: "+12014290422",
    MAILCALL_TWILIO_AUTH_TOKEN: "",
    MAILCALL_VALIDATE_TWILIO_SIGNATURES: false,
    MAILCALL_WP_URL: "https://wp.example",
    MAILCALL_WP_USER: "editor",
    MAILCALL_WP_APP_PASSWORD: "abcdefghijklmnopqrstuvwx",
    MAILCALL_OPENAI_API_KEY: "",
    MAILCALL_OPENAI_MODEL: "gpt-4o-mini",
    MAILCALL_CACHE_TTL_MS: 60_000,
    MAILCALL_WP_TIMEOUT_MS: 2_500,
    MAILCALL_PORT: 8010,
    MAILCALL_LOG_LEVEL: "error",
    wpAppPasswordClean: "abcdefghijklmnopqrstuvwx",
    wpBaseUrl: "https://wp.example",
    ...partial,
  };
}

describe("resolvePublicBaseUrl", () => {
  beforeEach(() => {
    resetConfigCache();
  });

  it("prefers env MAILCALL_PUBLIC_BASE_URL", () => {
    expect(
      resolvePublicBaseUrl(undefined, cfg({ MAILCALL_PUBLIC_BASE_URL: "https://env.example" })),
    ).toBe("https://env.example");
  });

  it("derives from forwarded request headers when env unset", () => {
    const req = {
      header: (name: string) => {
        if (name === "x-forwarded-proto") return "https";
        if (name === "x-forwarded-host") return "agent.mailcallcommunication.com";
        return undefined;
      },
      protocol: "http",
      get: () => "localhost:8010",
    } as unknown as Request;

    expect(resolvePublicBaseUrl(req, cfg())).toBe("https://agent.mailcallcommunication.com");
  });

  it("falls back to production host when nothing else is available", () => {
    expect(resolvePublicBaseUrl(undefined, cfg())).toBe(
      "https://agent.mailcallcommunication.com",
    );
  });
});
