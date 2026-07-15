/**
 * Decoupled WordPress REST data layer for Mail Call Voice AI.
 * Fetches /wp-json/wp/v2/posts (+ categories) with Basic Auth,
 * hard 2s timeout, and silent fallback to the local brand profile.
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

  /** Basic Auth header; Application Password spaces already stripped in config. */
  private authHeader(): string {
    const token = Buffer.from(
      `${this.cfg.MAILCALL_WP_USER}:${this.cfg.wpAppPasswordClean}`,
      "utf8",
    ).toString("base64");
    return `Basic ${token}`;
  }

  private async wpFetch<T>(pathAndQuery: string): Promise<T> {
    const base = (this.cfg.wpBaseUrl || DEFAULT_MAILCALL_WP_URL).replace(/\/$/, "");
    const url = `${base}/wp-json/wp/v2${pathAndQuery}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

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

      // Auth / upstream failures → silent offline path (no throw to caller of retrieveForQuery).
      if (res.status === 401 || res.status === 403 || res.status === 503 || res.status >= 500) {
        throw new WordPressApiError(`CMS HTTP ${res.status}`, res.status);
      }
      if (!res.ok) {
        throw new WordPressApiError(`CMS HTTP ${res.status}`, res.status);
      }

      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof WordPressApiError) throw err;
      const name = err instanceof Error ? err.name : "Error";
      const message = err instanceof Error ? err.message : String(err);
      if (name === "AbortError" || /timed?\s*out/i.test(message)) {
        throw new WordPressApiError("ETIMEDOUT", undefined, err);
      }
      if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed/i.test(message)) {
        throw new WordPressApiError(message, undefined, err);
      }
      throw new WordPressApiError(message || "CMS request failed", undefined, err);
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
