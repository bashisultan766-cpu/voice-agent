/**
 * Decoupled WordPress REST data layer for Mail Call Voice AI.
 * Fetches /wp-json/wp/v2/posts (+ categories) with Basic Auth,
 * GoDaddy-compatible browser headers, hard 2s timeout, and silent
 * fallback to the local brand profile.
 */

import { DEFAULT_MAILCALL_WP_URL, getConfig, type MailCallConfig } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { TtlCache } from "./ttlCache.js";
import { cleanseForSpeech, truncateToSentences } from "./textCleaner.js";
import {
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

/** Voice budget: never wait longer than this for CMS. */
export const WP_REQUEST_TIMEOUT_MS = 2000;

/** One silent retry on transient socket failures before brand-profile fallback. */
const WP_TRANSIENT_RETRIES = 1;

/** Browser-like headers — GoDaddy / ModSecurity often block bare Node UA strings. */
export const WP_BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
} as const;

const POST_FIELDS = "id,date,modified,slug,link,title,excerpt,content,categories,tags,meta";
const CATEGORY_FIELDS = "id,name,slug,count,description";

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

  /** Basic Auth header; Application Password spaces already stripped in config. */
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

  /**
   * Build a fully encoded WP REST URL.
   * Query values go through URLSearchParams (encodeURIComponent-equivalent).
   */
  buildWpUrl(resourcePath: string, params: Record<string, string | number>): string {
    const path = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
    const url = new URL(`${this.baseUrl()}/wp-json/wp/v2${path}`);
    for (const [key, value] of Object.entries(params)) {
      // Explicit encodeURIComponent then set via searchParams would double-encode;
      // URLSearchParams.set encodes once — correct for WP `search=` terms.
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async wpFetchOnce<T>(url: string, signal: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: this.requestHeaders(),
      signal,
      redirect: "follow",
    });

    // Auth / upstream failures → silent offline path (no throw to caller of retrieveForQuery).
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
  ): Promise<T> {
    const url = this.buildWpUrl(resourcePath, params);
    let lastErr: unknown;

    for (let attempt = 0; attempt <= WP_TRANSIENT_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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

  async listRecentPosts(perPage = 10): Promise<MailCallArticle[]> {
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
    const q = query.trim().slice(0, 120);
    if (!q) return this.listRecentPosts(perPage);

    const key = `posts:search:${q.toLowerCase()}:${perPage}`;
    return this.searchCache.getOrLoad(key, async () => {
      // `search` is passed as a raw string; buildWpUrl / URLSearchParams encodes it.
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
    return this.categoriesCache.getOrLoad("categories:all", async () => {
      const raw = await this.wpFetch<WpCategoryRaw[]>("/categories", {
        per_page: 100,
        _fields: CATEGORY_FIELDS,
      });
      return raw.map(normalizeCategory);
    });
  }

  /**
   * Knowledge retrieval for a caller utterance.
   * Never throws — on CMS failure returns brand-profile fallback (caller-safe).
   */
  async retrieveForQuery(query: string): Promise<KnowledgeHit> {
    const started = Date.now();

    // Identity / about questions → static brand profile (no CMS round-trip).
    const brandHit = matchBrandProfileQuery(query);
    if (brandHit) {
      return {
        articles: [],
        categories: [],
        degraded: false,
        usedBrandProfile: true,
        brandSpeech: brandHit,
        brandKnowledge: buildBrandProfileKnowledgeBlock(),
        cacheHit: true,
        latencyMs: Date.now() - started,
      };
    }

    const q = query.trim().slice(0, 120);
    const searchKey = q ? `posts:search:${q.toLowerCase()}:8` : `posts:recent:8`;
    const cacheHit =
      this.searchCache.get(searchKey) !== undefined ||
      (!q && this.postsCache.get("posts:recent:8") !== undefined);

    try {
      const [articles, categories] = await Promise.all([
        this.searchPosts(query),
        this.listCategories().catch(() => [] as MailCallCategory[]),
      ]);

      return {
        articles,
        categories,
        degraded: false,
        usedBrandProfile: false,
        cacheHit,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // SRE signal only — never surface to the caller.
      logger.warn("[WP_CLIENT_OFFLINE] Routing query to static local brand profile.", {
        reason,
        queryPreview: query.slice(0, 80),
        timeoutMs: this.timeoutMs,
      });

      return {
        articles: [],
        categories: [],
        degraded: true,
        usedBrandProfile: true,
        brandSpeech: brandOfflineFallbackSpeech(query),
        brandKnowledge: buildBrandProfileKnowledgeBlock(),
        degradeReason: reason,
        cacheHit: false,
        latencyMs: Date.now() - started,
      };
    }
  }

  /** Natural offline / brand speech for routers (never technical). */
  static unavailableSpeech(): string {
    return brandOfflineFallbackSpeech("");
  }

  clearCaches(): void {
    this.postsCache.clear();
    this.categoriesCache.clear();
    this.searchCache.clear();
  }
}

let defaultClient: WordPressApiClient | null = null;

export function getWordPressApiClient(): WordPressApiClient {
  if (!defaultClient) defaultClient = new WordPressApiClient();
  return defaultClient;
}

export function resetWordPressApiClient(): void {
  defaultClient = null;
}
