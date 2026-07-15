import { describe, expect, it, beforeEach, vi } from "vitest";
import type { MailCallConfig } from "../src/config.js";
import { resetConfigCache } from "../src/config.js";
import { WordPressApiClient } from "../src/agents/mailcall/wordpress_api.js";
import {
  clearSession,
  processConversationTurn,
} from "../src/agents/mailcall/conversation.js";
import { buildRetrievalOnlySpeech } from "../src/agents/mailcall/prompts.js";

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
    MAILCALL_TRANSFER_NUMBER: "",
    MAILCALL_CACHE_TTL_MS: 60_000,
    MAILCALL_WP_TIMEOUT_MS: 500,
    MAILCALL_PORT: 8010,
    MAILCALL_LOG_LEVEL: "error",
    RESEND_API_KEY: "",
    RESEND_FROM_EMAIL: "",
    RESEND_FROM_NAME: "MailCall Newspaper",
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

  it("falls back to natural brand speech when mem index is cold", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const wp = new WordPressApiClient(testConfig(), fetchImpl);

    const result = await processConversationTurn(
      { callSid: "call-1", utterance: "What is the top story?" },
      wp,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.degraded).toBe(true);
    expect(result.usedBrandProfile).toBe(true);
    expect(result.speech.toLowerCase()).toContain("mail call");
    expect(result.speech).not.toMatch(/api|wordpress|error|server|database/i);
  });

  it("answers identity from brand profile without CMS", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const wp = new WordPressApiClient(testConfig(), fetchImpl);

    const result = await processConversationTurn(
      { callSid: "call-1", utterance: "What is Mail Call Communication?" },
      wp,
    );

    expect(result.usedBrandProfile).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.speech.toLowerCase()).toMatch(/news|inmate|mailcall|newspaper|journalism/);
  });

  it("answers pricing from Brook product catalog without OpenAI", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const wp = new WordPressApiClient(testConfig(), fetchImpl);

    const result = await processConversationTurn(
      { callSid: "call-1", utterance: "How much is the three month plan?" },
      wp,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.speech.toLowerCase()).toMatch(/fifty-nine|three month|3-month/);
    expect(result.speech).not.toMatch(/api|wordpress|json/i);
  });

  it("states all-sales-final on refund requests", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const wp = new WordPressApiClient(testConfig(), fetchImpl);

    const result = await processConversationTurn(
      { callSid: "call-1", utterance: "I want a refund please" },
      wp,
    );

    expect(result.speech.toLowerCase()).toMatch(/final|does not permit|returns/);
  });

  it("locks purchase intent into deterministic nine-slot intake before submission", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const wp = new WordPressApiClient(testConfig(), fetchImpl);
    let submitted: Record<string, unknown> | undefined;
    const toolExecutor = vi.fn(
      async (_name: string, rawArgs: string | undefined) => {
        submitted = JSON.parse(rawArgs ?? "{}") as Record<string, unknown>;
        return {
          toolPayload: { ok: true, messageId: "email-1" },
          spokenHint: "sent",
        };
      },
    );

    const turn = (utterance: string) =>
      processConversationTurn(
        { callSid: "intake-1", utterance },
        wp,
        toolExecutor,
      );

    expect((await turn("I want to buy the Urban edition for 3 months")).speech).toMatch(
      /full name/i,
    );
    expect((await turn("Mary Smith")).speech).toMatch(/email address/i);
    expect((await turn("mary dot smith at gmail dot com")).speech).toBe(
      "Got it. Before I submit this to our fulfillment team, what is your preferred contact phone number?",
    );
    expect((await turn("two one two five five five zero one nine eight")).speech).toMatch(
      /inmate's full legal name/i,
    );
    expect((await turn("John Robert Smith")).speech).toMatch(/booking|identification/i);
    expect((await turn("A 12345")).speech).toMatch(/official name/i);
    expect((await turn("Albany Correctional Center")).speech).toMatch(
      /shipping address/i,
    );
    const final = await turn("1 Main Street, Albany, New York 12207");

    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(submitted).toEqual({
      sender_name: "Mary Smith",
      sender_email: "mary.smith@gmail.com",
      sender_phone: "2125550198",
      inmate_name: "John Robert Smith",
      inmate_number: "A 12345",
      facility_name: "Albany Correctional Center",
      facility_address: "1 Main Street, Albany, New York 12207",
      newspaper_selection: "Urban",
      plan_duration: 3,
    });
    expect(final.speech).toContain("compiled all your details");
    expect(final.speech).toContain("next business day");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects invalid intake slots and does not submit early", async () => {
    const wp = new WordPressApiClient(
      testConfig(),
      vi.fn() as unknown as typeof fetch,
    );
    const toolExecutor = vi.fn(async () => ({
      toolPayload: { ok: true },
    }));

    await processConversationTurn(
      { callSid: "intake-2", utterance: "I want to purchase a newspaper plan" },
      wp,
      toolExecutor,
    );
    await processConversationTurn(
      { callSid: "intake-2", utterance: "Mary Smith" },
      wp,
      toolExecutor,
    );
    const invalidEmail = await processConversationTurn(
      { callSid: "intake-2", utterance: "not an email" },
      wp,
      toolExecutor,
    );

    expect(invalidEmail.speech).toMatch(/email slowly/i);
    expect(toolExecutor).not.toHaveBeenCalled();
  });

  it("summarizes articles from mem index without OpenAI or live CMS", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const wp = new WordPressApiClient(testConfig(), fetchImpl);
    wp.hydrateMemIndex({
      warmedAt: Date.now(),
      articles: [
        {
          id: 9,
          title: "Harbor Cleanup Begins",
          excerpt: "Crews started clearing debris from the north pier this morning.",
          content: "Officials expect two weeks of work on the harbor.",
          spokenSummary:
            "Crews started clearing debris from the north pier this morning. Officials expect two weeks of work.",
          categoryIds: [1],
          customFields: {},
          slug: "harbor-cleanup",
        },
      ],
    });

    const result = await processConversationTurn(
      { callSid: "call-1", utterance: "harbor news" },
      wp,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.degraded).toBe(false);
    expect(result.articlesUsed).toBeGreaterThan(0);
    expect(result.articlesUsed).toBeLessThanOrEqual(2);
    expect(result.speech.toLowerCase()).toMatch(/debris|pier|harbor/);
    expect(result.speech).not.toMatch(/https?:\/\//);
    expect(result.speech.split(/[.!?]+/).filter(Boolean).length).toBeLessThanOrEqual(4);
  });

  it("buildSystemPrompt names Brook and requires send_support_escalation", async () => {
    const { buildSystemPrompt } = await import("../src/agents/mailcall/prompts.js");
    const prompt = buildSystemPrompt(new Date("2026-07-15T12:00:00Z"));
    expect(prompt).toMatch(/strictly Brook/i);
    expect(prompt).toContain("send_support_escalation");
    expect(prompt).toMatch(/Urban.*Spanish.*Global/s);
    expect(prompt).toMatch(/all nine values/i);
    expect(prompt).toMatch(/\$21\.66/);
    expect(prompt).toMatch(/ALL SALES ARE FINAL/i);
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
      {},
    );
    expect(speech).toContain("High winds");
    expect(speech!.length).toBeLessThan(220);
  });
});
