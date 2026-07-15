/**
 * Decoupled WordPress REST data layer for Mail Call Voice AI.
 *
 * Live voice turns NEVER wait on GoDaddy — they search a warmed in-memory index.
 * Network I/O runs only at startup warm + stale-while-revalidate background sync.
 */

import { DEFAULT_MAILCALL_WP_URL, getConfig, type MailCallConfig } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { TtlCache } from "./ttlCache.js";
import { cleanseForSpeech, normalizeVoiceTranscript, truncateToSentences } from "./textCleaner.js";
import {
  BRAND_SPOKEN_ANSWERS,
  brandOfflineFallbackSpeech,
  buildBrandProfileKnowledgeBlock,
  matchBrandProfileQuery,
} from "./brandProfile.js";
import type {
  KnowledgeHit,
  MailCallArticle,
  MailCallCategory,
  WpCategoryRaw,
  WpPostRaw,
} from "./types.js";

/** Background / warm CMS budget (not used on live call path). */
export const WP_REQUEST_TIMEOUT_MS = 2000;

/** Longer budget for out-of-band warm + SWR sync only. */
export const WP_BACKGROUND_TIMEOUT_MS = 12_000;

/** Kept for telemetry compatibility — live path no longer races the network. */
export const LIVE_RAG_TIMEOUT_MS = 1000;

/** Live call RAG: inject at most this many articles into the turn prompt. */
export const LIVE_RAG_MAX_ARTICLES = 2;

/** Posts pulled into the memory index on warm / SWR. */
export const MEM_INDEX_POST_LIMIT = 50;

/** SWR interval — refresh mem index without blocking calls. */
export const MEM_INDEX_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** One silent retry on transient socket failures (background only). */
const WP_TRANSIENT_RETRIES = 1;

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "i",
  "me",
  "my",
  "you",
  "your",
  "we",
  "our",
  "to",
  "of",
  "in",
  "on",
  "for",
  "and",
  "or",
  "but",
  "with",
  "about",
  "what",
  "who",
  "how",
  "when",
  "where",
  "why",
  "can",
  "could",
  "would",
  "should",
  "please",
  "tell",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "this",
  "that",
  "these",
  "those",
  "it",
  "from",
  "at",
  "be",
  "been",
  "being",
  "so",
  "just",
  "like",
  "want",
  "need",
  "get",
  "got",
  "know",
  "hello",
  "hi",
  "hey",
  "thanks",
  "thank",
  "um",
  "uh",
  "yeah",
  "yes",
  "no",
  "okay",
  "ok",
  "mailcall",
  "mail",
  "call",
  "newspaper",
]);

export interface MemIndexSnapshot {
  articles: MailCallArticle[];
  categories: MailCallCategory[];
  /** Full structural page snapshot from `/pages?per_page=20`. */
  pages: MailCallArticle[];
  /** Direct lookup for high-priority corporate identity pages. */
  corporatePages: Partial<Record<CorporatePageSlug, MailCallArticle>>;
  warmedAt: number;
  version: number;
}

export const CORPORATE_PAGE_SLUGS = [
  "about",
  "about-us",
  "contact",
  "contact-us",
  "advertise",
  "advertise-with-us",
] as const;

export type CorporatePageSlug = (typeof CORPORATE_PAGE_SLUGS)[number];

const CORPORATE_SLUG_PATTERNS: ReadonlyArray<{
  canonicalSlug: "contact" | "about" | "advertise";
  pattern: RegExp;
}> = [
  { canonicalSlug: "contact", pattern: /(contact|touch|write|reach|support)/i },
  { canonicalSlug: "about", pattern: /(about|story|mission|vision|purpose|identity)/i },
  { canonicalSlug: "advertise", pattern: /(advertise|promo|partner|business)/i },
];

/**
 * Extract compact search terms from a raw voice transcript for local index match.
 * Applies phonetic STT repair first.
 */
export function extractSearchTerms(utterance: string): string {
  const raw = normalizeVoiceTranscript(utterance);
  if (!raw) return "";

  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !SEARCH_STOP_WORDS.has(t));

  const unique = [...new Set(tokens)];
  const joined = unique.slice(0, 8).join(" ").trim();
  return joined || raw.slice(0, 80);
}

/** Score an article against tokenized query terms (mini in-memory VSS). */
export function scoreArticleAgainstTerms(article: MailCallArticle, terms: string[]): number {
  if (terms.length === 0) return 0;
  const title = article.title.toLowerCase();
  const excerpt = article.excerpt.toLowerCase();
  const content = article.content.toLowerCase().slice(0, 1200);
  const slug = (article.slug ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (title.includes(term)) score += 6;
    if (slug.includes(term)) score += 4;
    if (excerpt.includes(term)) score += 3;
    if (content.includes(term)) score += 2;
  }
  return score;
}

/** Browser-like headers — GoDaddy / ModSecurity often block bare Node UA strings. */
export const WP_BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
} as const;

const POST_FIELDS = "id,date,modified,slug,link,title,excerpt,content,categories,tags,meta";
const CATEGORY_FIELDS = "id,name,slug,count,description";
const PAGE_FIELDS = "id,date,modified,slug,link,title,content";

export function buildCorporatePageMap(
  pages: MailCallArticle[],
): Partial<Record<CorporatePageSlug, MailCallArticle>> {
  const map: Partial<Record<CorporatePageSlug, MailCallArticle>> = {};
  for (const page of pages) {
    const slug = (page.slug ?? "").trim().toLowerCase();
    if (!slug) continue;

    // Preserve exact aliases when WordPress happens to use a known slug.
    if ((CORPORATE_PAGE_SLUGS as readonly string[]).includes(slug)) {
      map[slug as CorporatePageSlug] = page;
    }

    // Also classify custom WordPress slugs such as "get-in-touch" or "our-story".
    for (const { canonicalSlug, pattern } of CORPORATE_SLUG_PATTERNS) {
      if (pattern.test(slug) && !map[canonicalSlug]) {
        map[canonicalSlug] = page;
      }
    }
  }
  return map;
}

export class WordPressApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WordPressApiError";
  }
}

function renderedText(field: WpPostRaw["title"]): string {
  if (!field) return "";
  if (typeof field === "string") return field;
  return field.rendered ?? "";
}

function normalizeArticle(raw: WpPostRaw): MailCallArticle {
  const title = cleanseForSpeech(renderedText(raw.title));
  const excerpt = cleanseForSpeech(renderedText(raw.excerpt));
  const content = cleanseForSpeech(renderedText(raw.content));
  const summarySource = excerpt || content || title;
  return {
    id: raw.id,
    title,
    excerpt,
    content,
    spokenSummary: truncateToSentences(summarySource || title, 2),
    date: raw.date,
    slug: raw.slug,
    categoryIds: Array.isArray(raw.categories) ? raw.categories : [],
    customFields: (raw.meta && typeof raw.meta === "object" ? raw.meta : {}) as Record<
      string,
      unknown
    >,
  };
}

function normalizeCategory(raw: WpCategoryRaw): MailCallCategory {
  return {
    id: raw.id,
    name: cleanseForSpeech(raw.name),
    slug: raw.slug,
    description: cleanseForSpeech(raw.description ?? ""),
    count: raw.count ?? 0,
  };
}

function resolveTimeoutMs(cfg: MailCallConfig): number {
  const configured = cfg.MAILCALL_WP_TIMEOUT_MS;
  if (!Number.isFinite(configured) || configured <= 0) return WP_REQUEST_TIMEOUT_MS;
  return Math.min(configured, WP_REQUEST_TIMEOUT_MS);
}

/** Flatten Node/undici nested causes into a single diagnostic string. */
export function flattenFetchError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current && depth < 6) {
    if (current instanceof Error) {
      if (current.message) parts.push(current.message);
      const code = (current as NodeJS.ErrnoException).code;
      if (code) parts.push(String(code));
      current = current.cause;
    } else if (typeof current === "object" && current !== null && "code" in current) {
      parts.push(String((current as { code: unknown }).code));
      break;
    } else {
      parts.push(String(current));
      break;
    }
    depth += 1;
  }
  return [...new Set(parts.filter(Boolean))].join(" | ") || "CMS request failed";
}

function isTransientNetworkFailure(message: string): boolean {
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EPIPE|UND_ERR|socket|network/i.test(
    message,
  );
}

export class WordPressApiClient {
  private readonly postsCache: TtlCache<MailCallArticle[]>;
  private readonly categoriesCache: TtlCache<MailCallCategory[]>;
  private readonly searchCache: TtlCache<MailCallArticle[]>;
  private readonly timeoutMs: number;
  private memIndex: MemIndexSnapshot = {
    articles: [],
    categories: [],
    pages: [],
    corporatePages: {},
    warmedAt: 0,
    version: 0,
  };
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  constructor(
    private readonly cfg: MailCallConfig = getConfig(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.timeoutMs = resolveTimeoutMs(cfg);
    this.postsCache = new TtlCache(cfg.MAILCALL_CACHE_TTL_MS);
    this.categoriesCache = new TtlCache(cfg.MAILCALL_CACHE_TTL_MS);
    this.searchCache = new TtlCache(Math.min(cfg.MAILCALL_CACHE_TTL_MS, 30_000));
  }

  private baseUrl(): string {
    return (this.cfg.wpBaseUrl || DEFAULT_MAILCALL_WP_URL).replace(/\/+$/, "");
  }

  private authHeader(): string {
    const token = Buffer.from(
      `${this.cfg.MAILCALL_WP_USER}:${this.cfg.wpAppPasswordClean}`,
      "utf8",
    ).toString("base64");
    return `Basic ${token}`;
  }

  private requestHeaders(): Record<string, string> {
    return {
      ...WP_BROWSER_HEADERS,
      Authorization: this.authHeader(),
    };
  }

  buildWpUrl(resourcePath: string, params: Record<string, string | number>): string {
    const path = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
    const url = new URL(`${this.baseUrl()}/wp-json/wp/v2${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  getMemIndex(): MemIndexSnapshot {
    return this.memIndex;
  }

  /** Test helper — inject a warm index without network. */
  hydrateMemIndex(partial: Partial<MemIndexSnapshot>): void {
    const pages = partial.pages ?? this.memIndex.pages;
    this.memIndex = {
      articles: partial.articles ?? this.memIndex.articles,
      categories: partial.categories ?? this.memIndex.categories,
      pages,
      corporatePages: partial.corporatePages ?? buildCorporatePageMap(pages),
      warmedAt: partial.warmedAt ?? Date.now(),
      version: (this.memIndex.version || 0) + 1,
    };
  }

  /** Local keyword search over warmed posts + pages. Never touches the network. */
  searchMemIndex(query: string, limit = LIVE_RAG_MAX_ARTICLES): MailCallArticle[] {
    const terms = extractSearchTerms(query)
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const corpus = [...this.memIndex.articles, ...this.memIndex.pages];
    if (corpus.length === 0) return [];

    if (terms.length === 0) {
      return corpus.slice(0, limit);
    }

    return corpus
      .map((article) => ({ article, score: scoreArticleAgainstTerms(article, terms) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((row) => row.article);
  }

  private async wpFetchOnce<T>(url: string, signal: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: this.requestHeaders(),
      signal,
      redirect: "follow",
    });

    if (res.status === 401 || res.status === 403 || res.status === 503 || res.status >= 500) {
      throw new WordPressApiError(`CMS HTTP ${res.status}`, res.status);
    }
    if (!res.ok) {
      throw new WordPressApiError(`CMS HTTP ${res.status}`, res.status);
    }

    return (await res.json()) as T;
  }

  private async wpFetch<T>(
    resourcePath: string,
    params: Record<string, string | number>,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const url = this.buildWpUrl(resourcePath, params);
    let lastErr: unknown;

    for (let attempt = 0; attempt <= WP_TRANSIENT_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await this.wpFetchOnce<T>(url, controller.signal);
      } catch (err) {
        if (err instanceof WordPressApiError) throw err;

        const name = err instanceof Error ? err.name : "Error";
        const message = flattenFetchError(err);

        if (name === "AbortError" || /timed?\s*out|aborted/i.test(message)) {
          throw new WordPressApiError("ETIMEDOUT", undefined, err);
        }

        lastErr = err;
        const canRetry =
          attempt < WP_TRANSIENT_RETRIES && isTransientNetworkFailure(message);
        if (canRetry) {
          logger.warn("[WP_CLIENT_RETRY] Transient CMS socket failure; retrying once.", {
            reason: message.slice(0, 160),
            attempt: attempt + 1,
          });
          continue;
        }

        throw new WordPressApiError(message, undefined, err);
      } finally {
        clearTimeout(timer);
      }
    }

    throw new WordPressApiError(flattenFetchError(lastErr), undefined, lastErr);
  }

  /** Background/admin path — may hit network (not used on live ConversationRelay turns). */
  async listRecentPosts(perPage = 10): Promise<MailCallArticle[]> {
    if (this.memIndex.articles.length > 0) {
      return this.memIndex.articles.slice(0, perPage);
    }
    const key = `posts:recent:${perPage}`;
    return this.postsCache.getOrLoad(key, async () => {
      const raw = await this.wpFetch<WpPostRaw[]>("/posts", {
        per_page: perPage,
        _fields: POST_FIELDS,
        orderby: "date",
        order: "desc",
      });
      return raw.map(normalizeArticle);
    });
  }

  async searchPosts(query: string, perPage = 8): Promise<MailCallArticle[]> {
    const local = this.searchMemIndex(query, perPage);
    if (local.length > 0 || this.memIndex.warmedAt > 0) {
      return local;
    }
    const q = normalizeVoiceTranscript(query).slice(0, 120);
    if (!q) return this.listRecentPosts(perPage);

    const key = `posts:search:${q.toLowerCase()}:${perPage}`;
    return this.searchCache.getOrLoad(key, async () => {
      const raw = await this.wpFetch<WpPostRaw[]>("/posts", {
        search: q,
        per_page: perPage,
        _fields: POST_FIELDS,
        orderby: "relevance",
      });
      return raw.map(normalizeArticle);
    });
  }

  async listCategories(): Promise<MailCallCategory[]> {
    if (this.memIndex.categories.length > 0) {
      return this.memIndex.categories;
    }
    return this.categoriesCache.getOrLoad("categories:all", async () => {
      const raw = await this.wpFetch<WpCategoryRaw[]>("/categories", {
        per_page: 100,
        _fields: CATEGORY_FIELDS,
      });
      return raw.map(normalizeCategory);
    });
  }

  /**
   * Pull top posts + categories + all structural pages into the memory index.
   * Safe to call repeatedly (SWR). Never throws to callers.
   */
  async warmCache(reason: "startup" | "swr" | "manual" = "manual"): Promise<boolean> {
    if (this.syncing) return false;
    this.syncing = true;
    const started = Date.now();
    try {
      const [postsRaw, categoriesRaw, pagesRaw] = await Promise.all([
        this.wpFetch<WpPostRaw[]>(
          "/posts",
          {
            per_page: MEM_INDEX_POST_LIMIT,
            _fields: POST_FIELDS,
            orderby: "date",
            order: "desc",
          },
          WP_BACKGROUND_TIMEOUT_MS,
        ),
        this.wpFetch<WpCategoryRaw[]>(
          "/categories",
          {
            per_page: 100,
            _fields: CATEGORY_FIELDS,
          },
          WP_BACKGROUND_TIMEOUT_MS,
        ).catch(() => [] as WpCategoryRaw[]),
        this.wpFetch<WpPostRaw[]>(
          "/pages",
          {
            per_page: 20,
            _fields: PAGE_FIELDS,
          },
          WP_BACKGROUND_TIMEOUT_MS,
        ).catch(() => [] as WpPostRaw[]),
      ]);

      const articles = postsRaw.map(normalizeArticle);
      const categories = categoriesRaw.map(normalizeCategory);
      const pages = pagesRaw.map(normalizeArticle);
      const corporatePages = buildCorporatePageMap(pages);
      const corporatePageMatches = [
        ...new Map(
          Object.values(corporatePages)
            .filter((page): page is MailCallArticle => Boolean(page))
            .map((page) => [page.id, page]),
        ).values(),
      ];
      this.memIndex = {
        articles,
        categories,
        pages,
        corporatePages,
        warmedAt: Date.now(),
        version: this.memIndex.version + 1,
      };

      // Seed TTL caches so legacy helpers stay coherent.
      this.postsCache.set(`posts:recent:${MEM_INDEX_POST_LIMIT}`, articles);
      this.categoriesCache.set("categories:all", categories);

      logger.info("[MEM_CACHE_WARM] In-memory WordPress index refreshed.", {
        reason,
        articles: articles.length,
        categories: categories.length,
        pages: pages.length,
        corporatePages: corporatePageMatches.length,
        corporatePageTitles: corporatePageMatches.map((page) => page.title),
        corporatePageSlugs: corporatePageMatches.map((page) => page.slug),
        latencyMs: Date.now() - started,
        version: this.memIndex.version,
      });
      return true;
    } catch (err) {
      const reasonMsg = err instanceof Error ? err.message : String(err);
      logger.warn("[MEM_CACHE_SWR] Background warm failed; keeping prior index.", {
        reason: reasonMsg.slice(0, 160),
        trigger: reason,
        hadPrior: this.memIndex.articles.length > 0,
        latencyMs: Date.now() - started,
      });
      return false;
    } finally {
      this.syncing = false;
    }
  }

  /** Fire-and-forget warm + 5-minute SWR loop. Does not block listen(). */
  startBackgroundSync(intervalMs = MEM_INDEX_SYNC_INTERVAL_MS): void {
    if (this.syncTimer) return;
    void this.warmCache("startup");
    this.syncTimer = setInterval(() => {
      void this.warmCache("swr");
    }, intervalMs);
    // Allow Node to exit in tests / short-lived processes.
    if (typeof this.syncTimer === "object" && "unref" in this.syncTimer) {
      this.syncTimer.unref();
    }
  }

  stopBackgroundSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private brandFallbackHit(
    query: string,
    started: number,
    opts?: { degraded?: boolean; degradeReason?: string; brandSpeech?: string },
  ): KnowledgeHit {
    const brandSpeech = opts?.brandSpeech ?? brandOfflineFallbackSpeech(query);
    return {
      articles: [],
      categories: this.memIndex.categories,
      degraded: Boolean(opts?.degraded),
      usedBrandProfile: true,
      brandSpeech,
      brandKnowledge: buildBrandProfileKnowledgeBlock(),
      degradeReason: opts?.degradeReason,
      cacheHit: !opts?.degraded,
      latencyMs: Date.now() - started,
    };
  }

  /**
   * Live / staging retrieval — memory index only (no network).
   * Phonetic normalize → brand mission/vision/about → local keyword search.
   */
  async retrieveForQuery(query: string): Promise<KnowledgeHit> {
    return this.retrieveFromMemIndex(query);
  }

  /**
   * Live voice-turn RAG: never awaits WordPress. Sub-10ms local index search.
   */
  async retrieveForLiveTurn(rawUtterance: string): Promise<KnowledgeHit> {
    return this.retrieveFromMemIndex(rawUtterance);
  }

  /**
   * Resolve organizational identity intents directly from structural pages.
   * Returns null for non-corporate queries; never touches the network.
   */
  retrieveCorporatePageContext(rawUtterance: string): KnowledgeHit | null {
    const started = Date.now();
    const normalized = normalizeVoiceTranscript(rawUtterance);
    const q = normalized.toLowerCase();
    if (!/\b(address|location|office|ceo|owner|meet|contact|advertis(?:e|ing))\b/i.test(q)) {
      return null;
    }

    // Headquarters is immutable business data. Never derive it from CMS text,
    // caller country codes, network location, or any environment-local signal.
    if (/\b(address|location|office|headquarters|located|based)\b/i.test(q)) {
      return this.brandFallbackHit(normalized, started, {
        brandSpeech: BRAND_SPOKEN_ANSWERS.officeAddress,
      });
    }

    let preferred: CorporatePageSlug[];
    let fallbackSpeech: string;
    if (/\badvertis(?:e|ing)\b/i.test(q)) {
      preferred = ["advertise-with-us", "advertise", "contact-us", "contact"];
      fallbackSpeech = BRAND_SPOKEN_ANSWERS.advertise;
    } else if (/\b(ceo|owner|meet)\b/i.test(q)) {
      preferred = ["about-us", "about", "contact-us", "contact"];
      fallbackSpeech = BRAND_SPOKEN_ANSWERS.leadership;
    } else {
      preferred = ["contact-us", "contact", "about-us", "about"];
      fallbackSpeech = BRAND_SPOKEN_ANSWERS.contact;
    }

    const page = preferred
      .map((slug) => this.memIndex.corporatePages[slug])
      .find((candidate): candidate is MailCallArticle => Boolean(candidate));

    if (page) {
      logger.info("[MEM_CACHE_HIT] Resolved corporate identity via structural page map.", {
        path: "corporate_page_map",
        slug: page.slug,
        latencyMs: Date.now() - started,
        indexVersion: this.memIndex.version,
      });
      return {
        articles: [page],
        categories: [],
        degraded: false,
        usedBrandProfile: false,
        cacheHit: true,
        latencyMs: Date.now() - started,
      };
    }

    logger.info("[MEM_CACHE_HIT] Corporate page missing; using brand profile coordinates.", {
      path: "corporate_brand_fallback",
      latencyMs: Date.now() - started,
      indexVersion: this.memIndex.version,
    });
    return this.brandFallbackHit(normalized, started, {
      brandSpeech: fallbackSpeech,
    });
  }

  private async retrieveFromMemIndex(rawUtterance: string): Promise<KnowledgeHit> {
    const started = Date.now();
    const normalized = normalizeVoiceTranscript(rawUtterance);

    const brandHit = matchBrandProfileQuery(normalized);
    if (brandHit) {
      logger.info("[MEM_CACHE_HIT] Resolved query via warmed in-memory index.", {
        path: "brand_profile",
        latencyMs: Date.now() - started,
        indexVersion: this.memIndex.version,
      });
      return this.brandFallbackHit(normalized, started, { brandSpeech: brandHit });
    }

    const articles = this.searchMemIndex(normalized, LIVE_RAG_MAX_ARTICLES);
    const latencyMs = Date.now() - started;

    if (articles.length > 0) {
      logger.info("[MEM_CACHE_HIT] Resolved query via warmed in-memory index.", {
        path: "article_index",
        articlesUsed: articles.length,
        latencyMs,
        indexVersion: this.memIndex.version,
        indexSize: this.memIndex.articles.length,
      });
      return {
        articles,
        categories: this.memIndex.categories,
        degraded: false,
        usedBrandProfile: false,
        cacheHit: true,
        latencyMs,
      };
    }

    // Cold index or no lexical match — natural brand speech, not a hard outage.
    if (this.memIndex.warmedAt === 0) {
      logger.warn("[MEM_CACHE_COLD] Index not warmed yet; serving brand profile.", {
        queryPreview: normalized.slice(0, 80),
        latencyMs,
      });
    } else {
      logger.info("[MEM_CACHE_HIT] Resolved query via warmed in-memory index.", {
        path: "brand_fallback_empty_match",
        latencyMs,
        indexVersion: this.memIndex.version,
      });
    }

    return this.brandFallbackHit(normalized, started, {
      degraded: this.memIndex.warmedAt === 0,
      degradeReason: this.memIndex.warmedAt === 0 ? "MEM_CACHE_COLD" : undefined,
    });
  }

  static unavailableSpeech(): string {
    return brandOfflineFallbackSpeech("");
  }

  clearCaches(): void {
    this.postsCache.clear();
    this.categoriesCache.clear();
    this.searchCache.clear();
    this.memIndex = {
      articles: [],
      categories: [],
      pages: [],
      corporatePages: {},
      warmedAt: 0,
      version: 0,
    };
  }
}

let defaultClient: WordPressApiClient | null = null;

export function getWordPressApiClient(): WordPressApiClient {
  if (!defaultClient) defaultClient = new WordPressApiClient();
  return defaultClient;
}

export function resetWordPressApiClient(): void {
  if (defaultClient) {
    defaultClient.stopBackgroundSync();
  }
  defaultClient = null;
}

/** Start warm + SWR on the singleton (called after HTTP listen). */
export function startWordPressMemCache(): void {
  getWordPressApiClient().startBackgroundSync();
}
