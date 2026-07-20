import { describe, expect, it, beforeEach, vi } from "vitest";
import type { MailCallConfig } from "../src/config.js";
import { resetConfigCache } from "../src/config.js";
import { WordPressApiClient } from "../src/agents/mailcall/wordpress_api.js";
import {
  clearSession,
  greetingSpeech,
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
    MAILCALL_CHECKOUT_URL: "https://mailcallnewspaper.com/register",
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

  it("uses the exact live pickup greeting", () => {
    expect(greetingSpeech()).toBe(
      "Thanks for calling MailCall Newspaper. I am Brook. How can I help you?",
    );
  });

  it("ends the call after a final goodbye, even during intake", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const wp = new WordPressApiClient(testConfig(), fetchImpl);

    await processConversationTurn(
      { callSid: "ending-call", utterance: "I want to subscribe to the newspaper" },
      wp,
    );
    const result = await processConversationTurn(
      { callSid: "ending-call", utterance: "No thanks, that's all. Goodbye." },
      wp,
    );

    expect(result.endCall).toBe(true);
    expect(result.speech).toBe(
      "You're very welcome. Thanks for calling MailCall Newspaper. Goodbye.",
    );
    expect(result.speech).not.toMatch(/anything else|how can i help/i);
    expect(fetchImpl).not.toHaveBeenCalled();
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
    expect(result.speech.toLowerCase()).toMatch(/fifty-three|three month|3-month/);
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

  it("refuses to collect inmate or facility details over the phone", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const wp = new WordPressApiClient(testConfig(), fetchImpl);

    const result = await processConversationTurn(
      { callSid: "privacy-1", utterance: "Do you need the inmate name and facility address?" },
      wp,
    );

    expect(result.speech.toLowerCase()).toMatch(/privacy|do not collect|checkout/i);
    expect(result.speech.toLowerCase()).not.toMatch(/what is the inmate/);
  });

  it("locks purchase intent into privacy-safe checkout-link intake", async () => {
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

    // Prefills Urban + 3 months from purchase utterance
    expect((await turn("I want to buy the Urban edition for 3 months")).speech).toMatch(
      /Single Edition|Bundle of Two|Bundle of Three/i,
    );
    expect((await turn("Single Edition")).speech).toMatch(/email/i);
    expect((await turn("mary dot smith at gmail dot com")).speech).toMatch(
      /mary at gmail|is that correct/i,
    );
    const final = await turn("yes");

    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolExecutor.mock.calls[0]?.[0]).toBe("send_checkout_link");
    expect(submitted).toEqual({
      contact_email: "mary.smith@gmail.com",
      newspaper_selection: "Urban",
      plan_duration: 3,
      package_type: "Single Edition",
    });
    expect(final.speech).toContain("secure direct checkout link");
    expect(final.speech.toLowerCase()).toMatch(/inmate's name|facility information/);
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
      { callSid: "intake-2", utterance: "Urban" },
      wp,
      toolExecutor,
    );
    await processConversationTurn(
      { callSid: "intake-2", utterance: "three months" },
      wp,
      toolExecutor,
    );
    await processConversationTurn(
      { callSid: "intake-2", utterance: "Single Edition" },
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

  it("bypasses article search for corporate identity page intents", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const wp = new WordPressApiClient(testConfig(), fetchImpl);
    wp.hydrateMemIndex({
      warmedAt: Date.now(),
      articles: [
        {
          id: 40,
          title: "Unrelated News",
          excerpt: "An unrelated story.",
          content: "General reporting.",
          spokenSummary: "An unrelated story.",
          categoryIds: [],
          customFields: {},
          slug: "unrelated-news",
        },
      ],
      pages: [
        {
          id: 41,
          title: "About Us",
          excerpt: "",
          content: "Our publishing team is led by chief executive Jane Example.",
          spokenSummary: "Our publishing team is led by chief executive Jane Example.",
          categoryIds: [],
          customFields: {},
          slug: "about-us",
        },
      ],
    });

    const result = await processConversationTurn(
      { callSid: "call-1", utterance: "Who is the CEO and owner?" },
      wp,
    );
    expect(result.speech).toMatch(/Jane Example/i);
    expect(result.speech).not.toMatch(/Unrelated News/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never derives headquarters from caller country or network geolocation", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const wp = new WordPressApiClient(testConfig(), fetchImpl);
    wp.hydrateMemIndex({
      warmedAt: Date.now(),
      pages: [
        {
          id: 42,
          title: "Contact",
          excerpt: "",
          content: "A localized environment supplied a different office.",
          spokenSummary: "A localized environment supplied a different office.",
          categoryIds: [],
          customFields: {},
          slug: "reach-support-team",
        },
      ],
    });

    const result = await processConversationTurn(
      {
        callSid: "geo-isolation",
        utterance: "What is your corporate office address?",
        callerPhone: "+92 300 0000000",
        callerCountryCode: "PK",
        networkGeolocation: "South Asia",
      },
      wp,
    );

    expect(result.speech).toContain(
      "650 East Palisade Ave #429, Englewood Cliffs, New Jersey 07632",
    );
    expect(result.speech).not.toContain("localized environment");
    expect(result.usedBrandProfile).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("buildSystemPrompt names Brook and requires send_checkout_link", async () => {
    const { buildSystemPrompt } = await import("../src/agents/mailcall/prompts.js");
    const prompt = buildSystemPrompt(new Date("2026-07-15T12:00:00Z"));
    expect(prompt).toMatch(/strictly Brook/i);
    expect(prompt).toContain("send_checkout_link");
    expect(prompt).toMatch(/Urban.*Spanish.*Global/s);
    expect(prompt).toMatch(/NEVER ask for or collect inmate name/i);
    expect(prompt).toMatch(/Under no circumstances say that MailCall does not have an address/i);
    expect(prompt).toMatch(/phone-number country code and network geolocation must NEVER/i);
    expect(prompt).toContain(
      "650 East Palisade Ave #429, Englewood Cliffs, New Jersey 07632",
    );
    expect(prompt).toContain("twenty-four-page all-in-one publication");
    expect(prompt).toContain("educate, entertain, and empower");
    expect(prompt).toContain("Periódico para Prisioneros");
    expect(prompt).toMatch(/give one brief goodbye and end the call/i);
    expect(prompt).toMatch(/\$19\.99/);
    expect(prompt).toMatch(/Bundle of Three/);
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
