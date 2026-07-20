import { describe, expect, it, beforeEach, vi } from "vitest";
import type { MailCallConfig } from "../src/config.js";
import { resetConfigCache } from "../src/config.js";
import { WordPressApiClient } from "../src/agents/mailcall/wordpress_api.js";
import {
  clearSession,
  greetingSpeech,
  processConversationTurn,
} from "../src/agents/mailcall/conversation.js";
import { clearCheckoutSendLock } from "../src/agents/mailcall/tools.js";
import { buildRetrievalOnlySpeech } from "../src/agents/mailcall/prompts.js";
import {
  applyEmailTokenCorrection,
  normalizeSpokenEmail,
  speakEmailForConfirm,
} from "../src/agents/mailcall/emailNormalize.js";

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
    clearCheckoutSendLock();
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
  });

  it("answers identity from brand profile without CMS", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const wp = new WordPressApiClient(testConfig(), fetchImpl);

    const result = await processConversationTurn(
      { callSid: "call-1", utterance: "What is Mail Call Communication?" },
      wp,
    );

    expect(result.usedBrandProfile).toBe(true);
    expect(result.speech.toLowerCase()).toMatch(/news|inmate|mailcall|newspaper|journalism/);
  });

  it("answers pricing from Brook product catalog without OpenAI", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const wp = new WordPressApiClient(testConfig(), fetchImpl);

    const result = await processConversationTurn(
      { callSid: "call-1", utterance: "How much is the three month plan?" },
      wp,
    );

    expect(result.speech.toLowerCase()).toMatch(/fifty-three|three month|3-month/);
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

    expect(result.speech.toLowerCase()).toMatch(/privacy|do not collect|send newspaper/i);
  });

  it("frictionlessly asks only for email on purchase intent", async () => {
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
        { callSid: "intake-flow", utterance },
        wp,
        toolExecutor,
      );

    const first = await turn("I want to send a newspaper");
    expect(first.speech).toMatch(/email/i);
    expect(first.speech).not.toMatch(/Urban|Bundle of Two|twelve month|at sign|dot for/i);

    const spelled = await turn("bashi sultan 766 at gmail.com");
    expect(spelled.speech).toMatch(/B-A-S-H-I/i);
    expect(spelled.speech).toMatch(/S-U-L-T-A-N/i);
    expect(spelled.speech).toMatch(/7-6-6/);
    expect(spelled.speech).toMatch(/gmail(\s+dot\s+com|\.com)/i);
    expect(spelled.speech).toMatch(/is that correct/i);

    const final = await turn("yes");

    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolExecutor.mock.calls[0]?.[0]).toBe("send_checkout_link");
    expect(submitted).toEqual({
      contact_email: "bashisultan766@gmail.com",
    });
    expect(final.speech.toLowerCase()).toMatch(/order link|email/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts natural email with an extra spoken at before digits", async () => {
    const wp = new WordPressApiClient(testConfig(), vi.fn() as unknown as typeof fetch);
    const toolExecutor = vi.fn(async () => ({ toolPayload: { ok: true } }));

    await processConversationTurn(
      { callSid: "nat-1", utterance: "I want to buy a newspaper" },
      wp,
      toolExecutor,
    );
    const spelled = await processConversationTurn(
      { callSid: "nat-1", utterance: "Bhashi Sultan at 766 at gmail.com" },
      wp,
      toolExecutor,
    );
    expect(spelled.speech).toMatch(/7-6-6/);
    expect(spelled.speech).toMatch(/gmail(\s+dot\s+com|\.com)/i);
    expect(toolExecutor).not.toHaveBeenCalled();
  });

  it("surgically patches an email token without wiping the address", async () => {
    const wp = new WordPressApiClient(testConfig(), vi.fn() as unknown as typeof fetch);
    const toolExecutor = vi.fn(async () => ({ toolPayload: { ok: true } }));

    await processConversationTurn(
      { callSid: "patch-1", utterance: "I want to purchase a newspaper" },
      wp,
      toolExecutor,
    );
    await processConversationTurn(
      { callSid: "patch-1", utterance: "bashi saub 64 at gmail.com" },
      wp,
      toolExecutor,
    );
    const corrected = await processConversationTurn(
      { callSid: "patch-1", utterance: "S A A B" },
      wp,
      toolExecutor,
    );

    expect(corrected.speech).toMatch(/S-A-A-B|B-A-S-H-I/i);
    expect(corrected.speech.toLowerCase()).toMatch(/gmail(\s+dot\s+com|\.com)/);
    expect(toolExecutor).not.toHaveBeenCalled();
  });

  it("collapses a double letter after phonetic confirm", async () => {
    const wp = new WordPressApiClient(testConfig(), vi.fn() as unknown as typeof fetch);
    const toolExecutor = vi.fn(async () => ({ toolPayload: { ok: true } }));

    await processConversationTurn(
      { callSid: "dbl-1", utterance: "I want to subscribe" },
      wp,
      toolExecutor,
    );
    await processConversationTurn(
      { callSid: "dbl-1", utterance: "bashi sultann 766 at gmail.com" },
      wp,
      toolExecutor,
    );
    const fixed = await processConversationTurn(
      { callSid: "dbl-1", utterance: "single n not double n" },
      wp,
      toolExecutor,
    );
    expect(fixed.speech).toMatch(/S-U-L-T-A-N/);
    expect(fixed.speech).not.toMatch(/N-N/);
  });

  it("locks duplicate checkout sends until explicit resend confirmation", async () => {
    const wp = new WordPressApiClient(testConfig(), vi.fn() as unknown as typeof fetch);
    const toolExecutor = vi.fn(async () => ({
      toolPayload: { ok: true, messageId: "m1" },
    }));

    const turn = (utterance: string) =>
      processConversationTurn({ callSid: "lock-1", utterance }, wp, toolExecutor);

    await turn("I want to subscribe");
    await turn("mary at gmail dot com");
    await turn("yes");
    expect(toolExecutor).toHaveBeenCalledTimes(1);

    const again = await turn("send me the link again");
    expect(again.speech).toMatch(/already sent/i);
    expect(toolExecutor).toHaveBeenCalledTimes(1);

    const resent = await turn("yes");
    expect(toolExecutor).toHaveBeenCalledTimes(2);
    expect(toolExecutor.mock.calls[1]?.[1]).toContain("force_resend");
    expect(resent.speech.toLowerCase()).toMatch(/resent|again|email/);
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
    const invalidEmail = await processConversationTurn(
      { callSid: "intake-2", utterance: "not an email" },
      wp,
      toolExecutor,
    );

    expect(invalidEmail.speech).toMatch(/one more time|didn't quite catch|email/i);
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

    expect(result.degraded).toBe(false);
    expect(result.speech.toLowerCase()).toMatch(/debris|pier|harbor/);
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
  });

  it("never derives headquarters from caller country or network geolocation", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const wp = new WordPressApiClient(testConfig(), fetchImpl);

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
  });

  it("buildSystemPrompt names Brook and requires frictionless send_checkout_link", async () => {
    const { buildSystemPrompt } = await import("../src/agents/mailcall/prompts.js");
    const prompt = buildSystemPrompt(new Date("2026-07-15T12:00:00Z"));
    expect(prompt).toMatch(/strictly Brook/i);
    expect(prompt).toContain("send_checkout_link");
    expect(prompt).toMatch(/do NOT ask about plans/i);
    expect(prompt).toMatch(/NEVER ask for or collect inmate name/i);
    expect(prompt).toMatch(/\$19\.99/);
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
  });
});

describe("email token correction", () => {
  it("patches Saub to Saab inside the local part only", () => {
    expect(applyEmailTokenCorrection("bashisaub64@gmail.com", "S A A B")).toBe(
      "bashisaab64@gmail.com",
    );
    expect(applyEmailTokenCorrection("bashisaub64@gmail.com", "change saub to saab")).toBe(
      "bashisaab64@gmail.com",
    );
  });

  it("collapses double letters from natural speech", () => {
    expect(
      applyEmailTokenCorrection("bashisultann766@gmail.com", "single n not double n"),
    ).toBe("bashisultan766@gmail.com");
  });

  it("normalizes natural spoken emails and phonetically spells them back", () => {
    expect(normalizeSpokenEmail("Bhashi Sultan 766 at gmail.com")).toBe(
      "bhashisultan766@gmail.com",
    );
    expect(normalizeSpokenEmail("Bhashi Sultan at 766 at gmail.com")).toBe(
      "bhashisultan766@gmail.com",
    );
    expect(speakEmailForConfirm("bashisultan766@gmail.com")).toMatch(/B-A-S-H-I/);
    expect(speakEmailForConfirm("bashisultan766@gmail.com")).toMatch(/7-6-6 at gmail dot com/);
  });
});
