import { describe, expect, it, beforeEach, vi } from "vitest";
import { cleanWpAppPassword, resetConfigCache, type MailCallConfig } from "../src/config.js";
import {
  WordPressApiClient,
  WP_BROWSER_HEADERS,
  flattenFetchError,
  extractSearchTerms,
  LIVE_RAG_MAX_ARTICLES,
  MEM_INDEX_POST_LIMIT,
} from "../src/agents/mailcall/wordpress_api.js";
import { normalizeVoiceTranscript } from "../src/agents/mailcall/textCleaner.js";

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
  return { ...base, ...overrides };
}

function sampleArticles() {
  return [
    {
      id: 1,
      title: "Harbor Cleanup Begins",
      excerpt: "Crews cleared the north pier.",
      content: "Harbor news about debris and pier work.",
      spokenSummary: "Crews cleared the north pier.",
      categoryIds: [1],
      customFields: {},
      slug: "harbor-cleanup",
    },
    {
      id: 2,
      title: "Budget Vote",
      excerpt: "Council approved the budget.",
      content: "City budget details.",
      spokenSummary: "Council approved the budget.",
      categoryIds: [1],
      customFields: {},
      slug: "budget-vote",
    },
    {
      id: 3,
      title: "School Fair",
      excerpt: "Students raised funds.",
      content: "School fair highlights.",
      spokenSummary: "Students raised funds.",
      categoryIds: [2],
      customFields: {},
      slug: "school-fair",
    },
  ];
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

  it("uses Basic Auth, browser headers when warming the mem index", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const auth = String(headers?.Authorization ?? "");
      expect(auth.startsWith("Basic ")).toBe(true);
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      expect(decoded).toBe("editor:abcdefghijklmnopqrstuvwx");
      expect(headers["User-Agent"]).toBe(WP_BROWSER_HEADERS["User-Agent"]);

      const href = String(url);
      if (href.includes("/categories")) {
        return new Response(JSON.stringify([{ id: 1, name: "Local", slug: "local", count: 2 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href.includes("/pages")) {
        return new Response(JSON.stringify([
          {
            id: 20,
            slug: "about-us",
            title: { rendered: "About <strong>Us</strong>" },
            content: {
              rendered:
                '<script>window.secret = "remove me"</script><p>Meet our publishing team.</p>[gallery id="7"]',
            },
          },
          {
            id: 21,
            slug: "contact-us",
            title: { rendered: "Contact Us" },
            content: { rendered: "<p>Office: 10 Newsroom Lane.</p>" },
          },
          {
            id: 22,
            slug: "advertise-with-us",
            title: { rendered: "Advertise With Us" },
            content: { rendered: "<p>Reach incarcerated readers and families.</p>" },
          },
        ]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
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
    const ok = await client.warmCache("manual");
    expect(ok).toBe(true);
    expect(client.getMemIndex().articles[0]?.title).toBe("City Council Votes");
    expect(client.getMemIndex().articles[0]?.spokenSummary).not.toContain("https://");
    expect(client.getMemIndex().pages).toHaveLength(3);
    expect(client.getMemIndex().corporatePages["about-us"]?.content).toBe(
      "Meet our publishing team.",
    );
    expect(client.getMemIndex().corporatePages["contact-us"]?.content).toContain(
      "10 Newsroom Lane",
    );
    expect(client.getMemIndex().corporatePages["advertise-with-us"]?.content).toContain(
      "incarcerated readers",
    );
    expect(
      fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/pages")),
    ).toHaveLength(1);
    expect(
      String(fetchImpl.mock.calls.find((c) => String(c[0]).includes("/pages"))?.[0]),
    ).toContain("per_page=20");
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes(`per_page=${MEM_INDEX_POST_LIMIT}`))).toBe(
      true,
    );
  });

  it("URL-encodes search terms when network search is used before warm", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get("search")).toBe("city & budget?");
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new WordPressApiClient(testConfig(), fetchImpl);
    await client.searchPosts("city & budget?");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("warmCache failure keeps prior index and does not throw", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;

    const client = new WordPressApiClient(testConfig(), fetchImpl);
    client.hydrateMemIndex({ articles: sampleArticles(), warmedAt: Date.now() });
    const ok = await client.warmCache("swr");
    expect(ok).toBe(false);
    expect(client.getMemIndex().articles).toHaveLength(3);
  });

  it("flattenFetchError surfaces nested undici causes", () => {
    const inner = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
    const outer = new Error("fetch failed", { cause: inner });
    expect(flattenFetchError(outer)).toMatch(/fetch failed/);
    expect(flattenFetchError(outer)).toMatch(/ECONNRESET/);
  });

  it("live retrieve hits mem index without network and is not degraded", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new WordPressApiClient(testConfig(), fetchImpl);
    client.hydrateMemIndex({ articles: sampleArticles(), warmedAt: Date.now() });

    const hit = await client.retrieveForLiveTurn("please tell me about the harbor news");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(hit.degraded).toBe(false);
    expect(hit.cacheHit).toBe(true);
    expect(hit.articles.length).toBeLessThanOrEqual(LIVE_RAG_MAX_ARTICLES);
    expect(hit.articles[0]?.title.toLowerCase()).toContain("harbor");
  });

  it("cold mem index falls back to brand profile without calling WordPress", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new WordPressApiClient(testConfig(), fetchImpl);
    const hit = await client.retrieveForQuery("top story");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(hit.usedBrandProfile).toBe(true);
    expect(hit.degraded).toBe(true);
    expect(hit.degradeReason).toBe("MEM_CACHE_COLD");
  });

  it("extractSearchTerms drops filler words and repairs phonetic brand STT", () => {
    expect(extractSearchTerms("um can you please tell me about the harbor cleanup")).toBe(
      "harbor cleanup",
    );
    expect(normalizeVoiceTranscript("tell me about the medical newspaper")).toMatch(
      /MailCall Newspaper/i,
    );
    expect(extractSearchTerms("what is the medical newspaper mission")).toContain("mission");
  });

  it("maps mission/vision queries to brand profile via mem path", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new WordPressApiClient(testConfig(), fetchImpl);
    client.hydrateMemIndex({ articles: sampleArticles(), warmedAt: Date.now() });

    const mission = await client.retrieveForLiveTurn("what is your purpose");
    expect(mission.usedBrandProfile).toBe(true);
    expect(mission.degraded).toBe(false);
    expect(mission.brandSpeech?.toLowerCase()).toMatch(/dedicated|mission|journalism/);

    const vision = await client.retrieveForLiveTurn("what is your vision");
    expect(vision.usedBrandProfile).toBe(true);
    expect(vision.brandSpeech?.toLowerCase()).toContain("vision");
  });

  it("routes corporate intents directly through the structural slug map", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new WordPressApiClient(testConfig(), fetchImpl);
    client.hydrateMemIndex({
      warmedAt: Date.now(),
      pages: [
        {
          id: 30,
          title: "Contact Us",
          excerpt: "",
          content: "Our office is at 10 Newsroom Lane.",
          spokenSummary: "Our office is at 10 Newsroom Lane.",
          categoryIds: [],
          customFields: {},
          slug: "contact-us",
        },
        {
          id: 31,
          title: "Advertise With Us",
          excerpt: "",
          content: "Advertising opportunities are available.",
          spokenSummary: "Advertising opportunities are available.",
          categoryIds: [],
          customFields: {},
          slug: "advertise-with-us",
        },
      ],
    });

    const office = client.retrieveCorporatePageContext("What is your office address?");
    expect(office?.articles[0]?.slug).toBe("contact-us");
    expect(office?.usedBrandProfile).toBe(false);

    const advertise = client.retrieveCorporatePageContext("How can I advertise?");
    expect(advertise?.articles[0]?.slug).toBe("advertise-with-us");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to hardcoded office coordinates when structural page is missing", () => {
    const client = new WordPressApiClient(
      testConfig(),
      vi.fn() as unknown as typeof fetch,
    );
    client.hydrateMemIndex({ warmedAt: Date.now(), pages: [] });
    const hit = client.retrieveCorporatePageContext("Where is your office address?");
    expect(hit?.usedBrandProfile).toBe(true);
    expect(hit?.brandSpeech).toMatch(/Abbottabad, Pakistan/i);
    expect(hit?.brandSpeech).not.toMatch(/do not have|don't have|no address/i);
  });
});
