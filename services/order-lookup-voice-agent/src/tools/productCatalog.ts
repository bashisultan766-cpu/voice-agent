import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { normalizeIsbn } from "../utils/productSearchNormalize.js";
import type { StructuredProduct } from "../types/product.js";

interface CatalogCache {
  products: StructuredProduct[];
  isbnIndex: Map<string, string>;
  loadedAt: number;
}

let catalogCache: CatalogCache | null = null;

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

function indexIsbn(map: Map<string, string>, value: string | undefined, productId: string): void {
  if (!value) return;
  const normalized = normalizeIsbn(value);
  if (normalized.length >= 8) {
    map.set(normalized, productId);
  }
}

function buildIsbnIndex(products: StructuredProduct[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const product of products) {
    for (const isbn of product.isbns ?? []) {
      indexIsbn(index, isbn, product.id);
    }
    for (const variant of product.variants) {
      indexIsbn(index, variant.sku, product.id);
      indexIsbn(index, variant.barcode, product.id);
    }
  }
  return index;
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
    if (!res.ok) throw new Error(`shopify_graphql_http_${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: unknown[] };
    if (body.errors?.length) throw new Error("shopify_graphql_error");
    return body.data as T;
  } finally {
    clearTimeout(timer);
  }
}

const CATALOG_QUERY = `query ($cursor: String) {
  products(first: 100, after: $cursor, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        title
        handle
        productType
        vendor
        tags
        description
        isbnCustom: metafield(namespace: "custom", key: "isbn") { value }
        isbnBooks: metafield(namespace: "books", key: "isbn") { value }
        isbnProduct: metafield(namespace: "product", key: "isbn") { value }
        variants(first: 10) {
          edges {
            node {
              id
              sku
              barcode
              price
              inventoryQuantity
            }
          }
        }
      }
    }
  }
}`;

async function fetchGraphqlCatalog(): Promise<StructuredProduct[]> {
  const products: StructuredProduct[] = [];
  let cursor: string | null = null;
  let pages = 0;

  while (pages < 20) {
    const data: {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        edges: Array<{
          node: {
            id: string;
            title: string;
            handle: string;
            productType: string;
            vendor: string;
            tags: string[];
            description: string;
            isbnCustom: { value: string } | null;
            isbnBooks: { value: string } | null;
            isbnProduct: { value: string } | null;
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
    } = await shopifyGraphql(CATALOG_QUERY, { cursor });

    for (const { node } of data.products?.edges ?? []) {
      const isbns = [node.isbnCustom?.value, node.isbnBooks?.value, node.isbnProduct?.value]
        .filter(Boolean)
        .map((v) => normalizeIsbn(String(v)));

      products.push({
        id: node.id.replace("gid://shopify/Product/", ""),
        title: node.title,
        handle: node.handle,
        productType: node.productType ?? "",
        vendor: node.vendor ?? "",
        author: node.vendor || undefined,
        tags: node.tags ?? [],
        isbns,
        descriptionSnippet: node.description?.slice(0, 160),
        variants: (node.variants?.edges ?? []).map(({ node: v }) => ({
          id: v.id.replace("gid://shopify/ProductVariant/", ""),
          sku: v.sku,
          barcode: v.barcode,
          price: v.price,
          inStock: v.inventoryQuantity > 0,
          inventoryQuantity: v.inventoryQuantity,
        })),
      });
    }

    pages++;
    if (!data.products?.pageInfo?.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }

  return products;
}

export async function getProductCatalog(force = false): Promise<CatalogCache> {
  const ttl = getConfig().SHOPIFY_CACHE_TTL_SECS * 1000;
  if (!force && catalogCache && Date.now() - catalogCache.loadedAt < ttl) {
    return catalogCache;
  }

  const products = await fetchGraphqlCatalog();
  const isbnIndex = buildIsbnIndex(products);

  catalogCache = { products, isbnIndex, loadedAt: Date.now() };
  logger.info("product_catalog_loaded", { count: products.length, isbnKeys: isbnIndex.size });
  return catalogCache;
}

export function getProductById(productId: string): StructuredProduct | null {
  return catalogCache?.products.find((p) => p.id === productId) ?? null;
}

export function lookupProductIdsByIsbn(isbn: string): string[] {
  if (!catalogCache) return [];
  const normalized = normalizeIsbn(isbn);
  const hits = new Set<string>();

  if (catalogCache.isbnIndex.has(normalized)) {
    hits.add(catalogCache.isbnIndex.get(normalized)!);
  }

  for (const [key, productId] of catalogCache.isbnIndex.entries()) {
    if (key.includes(normalized) || normalized.includes(key)) {
      if (key.length >= 8 || normalized.length >= 8) hits.add(productId);
    }
  }

  return [...hits];
}

export function clearCatalogCache(): void {
  catalogCache = null;
}
