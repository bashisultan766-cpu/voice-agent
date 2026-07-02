import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import type {
  InventoryStatus,
  ProductSearchResult,
  StructuredProduct,
} from "../types/product.js";

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const cache = new Map<string, CacheEntry<unknown>>();

interface ShopifyVariant {
  id?: number;
  sku?: string;
  barcode?: string;
  price?: string;
  inventory_quantity?: number;
}

interface ShopifyProduct {
  id?: number;
  title?: string;
  handle?: string;
  product_type?: string;
  vendor?: string;
  tags?: string;
  body_html?: string;
  status?: string;
  variants?: ShopifyVariant[];
}

function shopifyBaseUrl(): string {
  const cfg = getConfig();
  const domain = cfg.SHOPIFY_SHOP_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}/admin/api/${cfg.SHOPIFY_API_VERSION}`;
}

function authHeaders(): Record<string, string> {
  return {
    "X-Shopify-Access-Token": getConfig().SHOPIFY_ADMIN_ACCESS_TOKEN,
    "Content-Type": "application/json",
  };
}

async function shopifyFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.SHOPIFY_TIMEOUT_MS);

  try {
    const res = await fetch(`${shopifyBaseUrl()}${path}`, {
      ...init,
      headers: { ...authHeaders(), ...(init?.headers ?? {}) },
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      logger.warn("shopify_product_api_error", {
        status: res.status,
        path,
        body: body.slice(0, 200),
      });
      throw new Error(`shopify_http_${res.status}`);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function shopifyGraphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.SHOPIFY_TIMEOUT_MS);

  try {
    const res = await fetch(`${shopifyBaseUrl()}/graphql.json`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`shopify_graphql_http_${res.status}`);
    }

    const body = (await res.json()) as { data?: T; errors?: unknown[] };
    if (body.errors?.length) {
      throw new Error("shopify_graphql_error");
    }
    return body.data as T;
  } finally {
    clearTimeout(timer);
  }
}

function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
}

function cacheSet<T>(key: string, value: T): void {
  const ttl = getConfig().SHOPIFY_CACHE_TTL_SECS * 1000;
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

export function normalizeIsbn(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

export function extractIsbnFromSpeech(text: string): string | null {
  const isbn13 = text.match(/\b97[89][\d-]{10,17}\b/);
  if (isbn13) return normalizeIsbn(isbn13[0]);

  const isbn10 = text.match(/\b[\dXx][\d-]{8,12}[\dXx]\b/);
  if (isbn10) return normalizeIsbn(isbn10[0]);

  const spoken = text.match(/\bisbn\s*#?\s*([\dXx-]{10,17})\b/i);
  if (spoken?.[1]) return normalizeIsbn(spoken[1]);

  return null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function mapVariant(v: ShopifyVariant) {
  const qty = Number(v.inventory_quantity ?? 0);
  return {
    id: String(v.id ?? ""),
    sku: v.sku,
    barcode: v.barcode,
    price: v.price ?? "0.00",
    inStock: qty > 0,
    inventoryQuantity: qty,
  };
}

function mapProduct(p: ShopifyProduct): StructuredProduct {
  const variants = (p.variants ?? []).map(mapVariant);
  return {
    id: String(p.id ?? ""),
    title: (p.title ?? "Untitled").trim(),
    handle: p.handle ?? "",
    productType: (p.product_type ?? "").trim(),
    vendor: (p.vendor ?? "").trim(),
    tags: (p.tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    variants,
    descriptionSnippet: p.body_html ? stripHtml(p.body_html).slice(0, 160) : undefined,
  };
}

function fuzzyScore(title: string, query: string): number {
  const t = title.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  if (t === q) return 1;
  if (t.includes(q)) return 0.9;
  const tokens = q.split(/\s+/).filter(Boolean);
  const matched = tokens.filter((tok) => t.includes(tok)).length;
  return matched / tokens.length;
}

function rankByTitle(products: StructuredProduct[], query: string): StructuredProduct[] {
  return [...products]
    .map((p) => ({ p, score: fuzzyScore(p.title, query) }))
    .filter((x) => x.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);
}

/** Fuzzy match Shopify product titles (partial names supported). */
export async function searchProductByTitle(query: string): Promise<ProductSearchResult> {
  const q = query.trim();
  if (!q) return { status: "not_found", products: [], query: q };

  const cacheKey = `title:${q.toLowerCase()}`;
  const cached = cacheGet<ProductSearchResult>(cacheKey);
  if (cached) return cached;

  try {
    const data = await shopifyFetch<{ products: ShopifyProduct[] }>(
      `/products.json?published_status=active&limit=50&title=${encodeURIComponent(q)}`,
    );
    let products = (data.products ?? []).map(mapProduct);
    products = rankByTitle(products, q);

    if (products.length === 0) {
      const broad = await shopifyFetch<{ products: ShopifyProduct[] }>(
        `/products.json?published_status=active&limit=100`,
      );
      products = rankByTitle((broad.products ?? []).map(mapProduct), q).slice(0, 8);
    }

    const result: ProductSearchResult = {
      status: products.length ? "found" : "not_found",
      products: products.slice(0, 5),
      query: q,
    };
    cacheSet(cacheKey, result);
    return result;
  } catch {
    return { status: "api_error", products: [], query: q, message: "Product catalog unavailable" };
  }
}

/** Search by ISBN-10/ISBN-13 via variant SKU, barcode, or GraphQL. */
export async function searchProductByISBN(isbn: string): Promise<ProductSearchResult> {
  const normalized = normalizeIsbn(isbn);
  if (!normalized) return { status: "not_found", products: [], query: isbn };

  const cacheKey = `isbn:${normalized}`;
  const cached = cacheGet<ProductSearchResult>(cacheKey);
  if (cached) return cached;

  try {
    const gql = await shopifyGraphql<{
      products: {
        edges: Array<{
          node: {
            id: string;
            title: string;
            handle: string;
            productType: string;
            vendor: string;
            tags: string[];
            description: string;
            variants: {
              edges: Array<{
                node: {
                  id: string;
                  sku: string;
                  barcode: string;
                  price: string;
                  inventoryQuantity: number;
                };
              }>;
            };
          };
        }>;
      };
    }>(
      `query ($q: String!) {
        products(first: 5, query: $q) {
          edges {
            node {
              id title handle productType vendor tags description
              variants(first: 5) {
                edges {
                  node { id sku barcode price inventoryQuantity }
                }
              }
            }
          }
        }
      }`,
      { q: `barcode:${normalized} OR sku:${normalized} OR tag:${normalized}` },
    );

    const products: StructuredProduct[] = (gql.products?.edges ?? []).map(({ node }) => ({
      id: node.id.replace("gid://shopify/Product/", ""),
      title: node.title,
      handle: node.handle,
      productType: node.productType ?? "",
      vendor: node.vendor ?? "",
      tags: node.tags ?? [],
      descriptionSnippet: node.description?.slice(0, 160),
      variants: (node.variants?.edges ?? []).map(({ node: v }) => ({
        id: v.id.replace("gid://shopify/ProductVariant/", ""),
        sku: v.sku,
        barcode: v.barcode,
        price: v.price,
        inStock: v.inventoryQuantity > 0,
        inventoryQuantity: v.inventoryQuantity,
      })),
    }));

    if (products.length > 0) {
      const result: ProductSearchResult = { status: "found", products, query: normalized };
      cacheSet(cacheKey, result);
      return result;
    }

    const fallback = await searchProductByTitle(normalized);
    cacheSet(cacheKey, fallback);
    return fallback;
  } catch {
    return { status: "api_error", products: [], query: normalized, message: "ISBN lookup unavailable" };
  }
}

/** Similar products by category, vendor, or shared tags. */
export async function getSimilarProducts(productId: string): Promise<ProductSearchResult> {
  const cacheKey = `similar:${productId}`;
  const cached = cacheGet<ProductSearchResult>(cacheKey);
  if (cached) return cached;

  try {
    const data = await shopifyFetch<{ product: ShopifyProduct }>(`/products/${productId}.json`);
    const source = mapProduct(data.product ?? {});

    const filters = [source.productType, source.vendor, ...source.tags.slice(0, 2)].filter(Boolean);
    const seen = new Set<string>([productId]);
    const similar: StructuredProduct[] = [];

    for (const filter of filters) {
      if (similar.length >= 5) break;
      const batch = await shopifyFetch<{ products: ShopifyProduct[] }>(
        `/products.json?published_status=active&limit=20&product_type=${encodeURIComponent(filter)}`,
      );
      for (const p of batch.products ?? []) {
        const mapped = mapProduct(p);
        if (!seen.has(mapped.id)) {
          seen.add(mapped.id);
          similar.push(mapped);
        }
      }
    }

    const result: ProductSearchResult = {
      status: similar.length ? "found" : "not_found",
      products: similar.slice(0, 5),
      query: `similar:${productId}`,
    };
    cacheSet(cacheKey, result);
    return result;
  } catch {
    return { status: "api_error", products: [], query: productId };
  }
}

/** Stock status for a product. */
export async function checkInventory(productId: string): Promise<InventoryStatus | null> {
  try {
    const data = await shopifyFetch<{ product: ShopifyProduct }>(`/products/${productId}.json`);
    const product = mapProduct(data.product ?? {});
    const totalQuantity = product.variants.reduce((sum, v) => sum + v.inventoryQuantity, 0);
    return {
      productId,
      title: product.title,
      inStock: product.variants.some((v) => v.inStock),
      totalQuantity,
      variantCount: product.variants.length,
    };
  } catch {
    return null;
  }
}

export function clearProductCache(): void {
  cache.clear();
}
