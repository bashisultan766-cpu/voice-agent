import { describe, expect, it, beforeEach, vi } from "vitest";
import type { MailCallConfig } from "../src/config.js";
import { resetConfigCache } from "../src/config.js";
import { WordPressApiClient } from "../src/agents/mailcall/wordpress_api.js";
import {
  clearSession,
  processConversationTurn,
} from "../src/agents/mailcall/conversation.js";
import { buildRetrievalOnlySpeech } from "../src/agents/mailcall/prompts.js";
import { WP_UNAVAILABLE_SPEECH } from "../src/agents/mailcall/types.js";

function testConfig(): MailCallConfig {
  return {
    MAILCALL_PUBLIC_BASE_URL: "https://voice.example",
    MAILCALL_TWILIO_PHONE_NUMBER: "+15551234567",
    MAILCALL_TWILIO_AUTH_TOKEN: "token",
    MAILCALL_VALIDATE_TWILIO_SIGNATURES: false,
    MAILCALL_TWILIO_SIGNATURE_STRICT: false,
    MAILCALL_WP_URL: "https://wp.example",
    MAILCALL_WP_USER: "editor",
    MAILCALL_WP_APP_PASSWORD: "abcdefghijklmnopqrstuvwx",
    MAILCALL_OPENAI_API_KEY: "",
    MAILCALL_OPENAI_MODEL: "gpt-4o-mini",
    MAILCALL_CACHE_TTL_MS: 60_000,
    MAILCALL_WP_TIMEOUT_MS: 500,
    MAILCALL_PORT: 8010,
    MAILCALL_LOG_LEVEL: "error",
    wpAppPasswordClean: "abcdefghijklmnopqrstuvwx",
    wpBaseUrl: "https://wp.example",
  };
}

describe("conversation + prompts", () => {
  beforeEach(() => {
    resetConfigCache();
    clearSession("call-1");
    vi.stubEnv("MAILCALL_TWILIO_PHONE_NUMBER", "+15551234567");
    vi.stubEnv("MAILCALL_WP_URL", "https://wp.example");
    vi.stubEnv("MAILCALL_WP_USER", "editor");
    vi.stubEnv("MAILCALL_WP_APP_PASSWORD", "abcdefghijklmnopqrstuvwx");
    vi.stubEnv("MAILCALL_OPENAI_API_KEY", "");
    vi.stubEnv("MAILCALL_VALIDATE_TWILIO_SIGNATURES", "false");
  });

  it("returns polite fallback when WordPress is down", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("down", { status: 500 }),
    ) as unknown as typeof fetch;
    const wp = new WordPressApiClient(testConfig(), fetchImpl);

    const result = await processConversationTurn(
      { callSid: "call-1", utterance: "What is the top story?" },
      wp,
    );

    expect(result.degraded).toBe(true);
    expect(result.speech).toBe(WP_UNAVAILABLE_SPEECH);
  });

  it("summarizes articles in short spoken turns without OpenAI", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/categories")) {
        return new Response(JSON.stringify([{ id: 1, name: "Local", slug: "local", count: 2 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify([
          {
            id: 9,
            title: { rendered: "Harbor Cleanup Begins" },
            excerpt: {
              rendered:
                "<p>Crews started clearing debris from the north pier this morning. Officials expect two weeks of work.</p>",
            },
            content: { rendered: "<p>More details...</p>" },
            categories: [1],
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const wp = new WordPressApiClient(testConfig(), fetchImpl);
    const result = await processConversationTurn(
      { callSid: "call-1", utterance: "harbor news" },
      wp,
    );

    expect(result.degraded).toBe(false);
    expect(result.articlesUsed).toBeGreaterThan(0);
    expect(result.speech.toLowerCase()).toMatch(/debris|pier|harbor/);
    expect(result.speech).not.toMatch(/https?:\/\//);
    expect(result.speech.split(/[.!?]+/).filter(Boolean).length).toBeLessThanOrEqual(4);
  });

  it("buildRetrievalOnlySpeech stays concise", () => {
    const speech = buildRetrievalOnlySpeech(
      [
        {
          id: 1,
          title: "Storm Watch",
          excerpt: "High winds overnight.",
          content: "",
          spokenSummary: "High winds are expected overnight across the county.",
          categoryIds: [],
          customFields: {},
        },
      ],
      false,
    );
    expect(speech).toContain("High winds");
    expect(speech!.length).toBeLessThan(220);
  });
});
