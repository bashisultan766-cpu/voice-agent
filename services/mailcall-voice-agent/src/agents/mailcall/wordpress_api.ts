/**
 * Decoupled WordPress REST data layer for Mail Call Voice AI.
 * Fetches /wp-json/wp/v2/posts (+ categories) with Basic Auth,
 * TTL cache, timeouts, and graceful degradation on 5xx/network failure.
 */

import { getConfig, type MailCallConfig } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { TtlCache } from "./ttlCache.js";
import { cleanseForSpeech, truncateToSentences } from "./textCleaner.js";
import type {
  KnowledgeHit,
  MailCallArticle,
  MailCallCategory,
  WpCategoryRaw,
  WpPostRaw,
} from "./types.js";
import { WP_UNAVAILABLE_SPEECH } from "./types.js";

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

export class WordPressApiClient {
  private readonly postsCache: TtlCache<MailCallArticle[]>;
  private readonly categoriesCache: TtlCache<MailCallCategory[]>;
  private readonly searchCache: TtlCache<MailCallArticle[]>;

  constructor(
    private readonly cfg: MailCallConfig = getConfig(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.postsCache = new TtlCache(cfg.MAILCALL_CACHE_TTL_MS);
    this.categoriesCache = new TtlCache(cfg.MAILCALL_CACHE_TTL_MS);
    this.searchCache = new TtlCache(Math.min(cfg.MAILCALL_CACHE_TTL_MS, 30_000));
  }

  /** Basic Auth header; Application Password spaces already stripped in config. */
  private authHeader(): string {
    const token = Buffer.from(
      `${this.cfg.MAILCALL_WP_USER}:${this.cfg.wpAppPasswordClean}`,
      "utf8",
    ).toString("base64");
    return `Basic ${token}`;
  }

  private async wpFetch<T>(pathAndQuery: string): Promise<T> {
    const url = `${this.cfg.wpBaseUrl}/wp-json/wp/v2${pathAndQuery}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.MAILCALL_WP_TIMEOUT_MS);

    try {
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: this.authHeader(),
          Accept: "application/json",
          "User-Agent": "MailCall-Voice-Agent/1.0",
        },
        signal: controller.signal,
      });

      if (res.status >= 500) {
        throw new WordPressApiError(`WordPress 5xx (${res.status})`, res.status);
      }
      if (!res.ok) {
        throw new WordPressApiError(`WordPress HTTP ${res.status}`, res.status);
      }

      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof WordPressApiError) throw err;
      const name = err instanceof Error ? err.name : "Error";
      if (name === "AbortError") {
        throw new WordPressApiError("WordPress request timed out", undefined, err);
      }
      throw new WordPressApiError(
        err instanceof Error ? err.message : "WordPress request failed",
        undefined,
        err,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async listRecentPosts(perPage = 10): Promise<MailCallArticle[]> {
    const key = `posts:recent:${perPage}`;
    return this.postsCache.getOrLoad(key, async () => {
      const raw = await this.wpFetch<WpPostRaw[]>(
        `/posts?per_page=${perPage}&_fields=id,date,modified,slug,link,title,excerpt,content,categories,tags,meta&orderby=date&order=desc`,
      );
      return raw.map(normalizeArticle);
    });
  }

  async searchPosts(query: string, perPage = 8): Promise<MailCallArticle[]> {
    const q = query.trim().slice(0, 120);
    if (!q) return this.listRecentPosts(perPage);

    const key = `posts:search:${q.toLowerCase()}:${perPage}`;
    return this.searchCache.getOrLoad(key, async () => {
      const encoded = encodeURIComponent(q);
      const raw = await this.wpFetch<WpPostRaw[]>(
        `/posts?search=${encoded}&per_page=${perPage}&_fields=id,date,modified,slug,link,title,excerpt,content,categories,tags,meta&orderby=relevance`,
      );
      return raw.map(normalizeArticle);
    });
  }

  async listCategories(): Promise<MailCallCategory[]> {
    return this.categoriesCache.getOrLoad("categories:all", async () => {
      const raw = await this.wpFetch<WpCategoryRaw[]>(
        `/categories?per_page=100&_fields=id,name,slug,count,description`,
      );
      return raw.map(normalizeCategory);
    });
  }

  /**
   * Knowledge retrieval for a caller utterance.
   * Never throws — returns degraded=true + empty articles on WP failure.
   */
  async retrieveForQuery(query: string): Promise<KnowledgeHit> {
    const started = Date.now();
    const q = query.trim().slice(0, 120);
    const searchKey = q
      ? `posts:search:${q.toLowerCase()}:8`
      : `posts:recent:8`;
    const cacheHit = this.searchCache.get(searchKey) !== undefined
      || (!q && this.postsCache.get("posts:recent:8") !== undefined);

    try {
      const [articles, categories] = await Promise.all([
        this.searchPosts(query),
        this.listCategories().catch(() => [] as MailCallCategory[]),
      ]);

      return {
        articles,
        categories,
        degraded: false,
        cacheHit,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn("mailcall_wp_degraded", { reason, queryPreview: query.slice(0, 80) });
      return {
        articles: [],
        categories: [],
        degraded: true,
        degradeReason: reason,
        cacheHit: false,
        latencyMs: Date.now() - started,
      };
    }
  }

  /** Expose polite fallback copy for routers / TTS without importing types everywhere. */
  static unavailableSpeech(): string {
    return WP_UNAVAILABLE_SPEECH;
  }

  /** Test helpers */
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
