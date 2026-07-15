import { describe, expect, it, beforeEach, vi } from "vitest";
import { cleanWpAppPassword, resetConfigCache, type MailCallConfig } from "../src/config.js";
import { WordPressApiClient } from "../src/agents/mailcall/wordpress_api.js";
import { WP_UNAVAILABLE_SPEECH } from "../src/agents/mailcall/types.js";

function testConfig(overrides: Partial<MailCallConfig> = {}): MailCallConfig {
  const base: MailCallConfig = {
    MAILCALL_PUBLIC_BASE_URL: "https://voice.example",
    MAILCALL_TWILIO_PHONE_NUMBER: "+15551234567",
    MAILCALL_TWILIO_AUTH_TOKEN: "token",
    MAILCALL_VALIDATE_TWILIO_SIGNATURES: false,
    MAILCALL_TWILIO_SIGNATURE_STRICT: false,
    MAILCALL_WP_URL: "https://wp.example",
    MAILCALL_WP_USER: "editor",
    MAILCALL_WP_APP_PASSWORD: "abcd efgh ijkl mnop qrst uvwx",
    MAILCALL_OPENAI_API_KEY: "",
    MAILCALL_OPENAI_MODEL: "gpt-4o-mini",
    MAILCALL_CACHE_TTL_MS: 60_000,
    MAILCALL_WP_TIMEOUT_MS: 500,
    MAILCALL_PORT: 8010,
    MAILCALL_LOG_LEVEL: "error",
    wpAppPasswordClean: "abcdefghijklmnopqrstuvwx",
    wpBaseUrl: "https://wp.example",
  };
  return { ...base, ...overrides };
}

describe("cleanWpAppPassword", () => {
  it("strips spaces from 24-char application passwords", () => {
    expect(cleanWpAppPassword("abcd efgh ijkl mnop qrst uvwx")).toBe(
      "abcdefghijklmnopqrstuvwx",
    );
  });
});

describe("WordPressApiClient", () => {
  beforeEach(() => {
    resetConfigCache();
  });

  it("uses Basic Auth with cleaned password and caches posts", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push(String(url));
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      expect(auth.startsWith("Basic ")).toBe(true);
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      expect(decoded).toBe("editor:abcdefghijklmnopqrstuvwx");

      return new Response(
        JSON.stringify([
          {
            id: 1,
            title: { rendered: "City Council <em>Votes</em>" },
            excerpt: { rendered: "<p>Members approved the budget.</p>" },
            content: { rendered: "<p>Longer body with https://example.com/x</p>" },
            categories: [3],
            meta: { beat: "politics" },
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = new WordPressApiClient(testConfig(), fetchImpl);
    const first = await client.listRecentPosts(5);
    const second = await client.listRecentPosts(5);

    expect(first[0]?.title).toBe("City Council Votes");
    expect(first[0]?.spokenSummary).toContain("budget");
    expect(first[0]?.spokenSummary).not.toContain("https://");
    expect(second[0]?.id).toBe(1);
    expect(calls.length).toBe(1);
  });

  it("degrades gracefully on 5xx without throwing", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("boom", { status: 503 }),
    ) as unknown as typeof fetch;

    const client = new WordPressApiClient(testConfig(), fetchImpl);
    const hit = await client.retrieveForQuery("budget");

    expect(hit.degraded).toBe(true);
    expect(hit.articles).toEqual([]);
    expect(WordPressApiClient.unavailableSpeech()).toBe(WP_UNAVAILABLE_SPEECH);
  });

  it("degrades on timeout/abort", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;

    const client = new WordPressApiClient(
      testConfig({ MAILCALL_WP_TIMEOUT_MS: 50 }),
      fetchImpl,
    );
    const hit = await client.retrieveForQuery("news");
    expect(hit.degraded).toBe(true);
    expect(hit.degradeReason).toMatch(/timed out/i);
  });
});
