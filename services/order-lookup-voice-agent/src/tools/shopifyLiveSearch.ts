import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import type { StructuredProduct } from "../types/product.js";

export interface GqlProductNode {
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
}

const PRODUCT_FIELDS = `
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
`;

const SEARCH_PRODUCTS_QUERY = `query LiveSearchProducts($query: String!, $first: Int!) {
  products(first: $first, query: $query) {
    edges {
      node { ${PRODUCT_FIELDS} }
    }
  }
}`;

const SEARCH_VARIANTS_QUERY = `query LiveSearchVariants($query: String!) {
  productVariants(first: 10, query: $query) {
    edges {
      node {
        id
        sku
        barcode
        product { ${PRODUCT_FIELDS} }
      }
    }
  }
}`;

const GET_PRODUCT_QUERY = `query LiveGetProduct($id: ID!) {
  product(id: $id) { ${PRODUCT_FIELDS} }
}`;

function shopifyBaseUrl(): string {
  const cfg = getConfig();
  const domain = cfg.SHOPIFY_SHOP_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}/admin/api/${cfg.SHOPIFY_API_VERSION}`;
}

export async function shopifyGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.SHOPIFY_TIMEOUT_MS);

  const started = Date.now();
  try {
    const res = await fetch(`${shopifyBaseUrl()}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": cfg.SHOPIFY_ADMIN_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`shopify_graphql_http_${res.status}:${body.slice(0, 120)}`);
    }

    const body = (await res.json()) as { data?: T; errors?: unknown[] };
    if (body.errors?.length) {
      throw new Error(`shopify_graphql_error:${JSON.stringify(body.errors).slice(0, 200)}`);
    }

    logger.debug("shopify_live_graphql_ok", {
      elapsedMs: Date.now() - started,
      query: query.split("\n")[0]?.trim(),
    });

    return body.data as T;
  } finally {
    clearTimeout(timer);
  }
}

export function mapGqlProduct(node: GqlProductNode): StructuredProduct {
  const isbns = [node.isbnCustom?.value, node.isbnBooks?.value, node.isbnProduct?.value]
    .filter(Boolean)
    .map((v) => String(v).replace(/[\s-]/g, "").toUpperCase());

  return {
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
  };
}

function dedupeProducts(products: StructuredProduct[]): StructuredProduct[] {
  const seen = new Set<string>();
  const out: StructuredProduct[] = [];
  for (const p of products) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/** Live Shopify product search — authoritative source of truth per query. */
export async function liveSearchProducts(shopifyQuery: string, first = 25): Promise<StructuredProduct[]> {
  const data = await shopifyGraphql<{
    products: { edges: Array<{ node: GqlProductNode }> };
  }>(SEARCH_PRODUCTS_QUERY, { query: shopifyQuery, first });

  return dedupeProducts((data.products?.edges ?? []).map(({ node }) => mapGqlProduct(node)));
}

/** Live variant search — SKU / barcode lookup path. */
export async function liveSearchVariants(shopifyQuery: string): Promise<StructuredProduct[]> {
  const data = await shopifyGraphql<{
    productVariants: {
      edges: Array<{ node: { product: GqlProductNode } }>;
    };
  }>(SEARCH_VARIANTS_QUERY, { query: shopifyQuery });

  const products = (data.productVariants?.edges ?? [])
    .map(({ node }) => node.product)
    .filter(Boolean)
    .map((node) => mapGqlProduct(node));

  return dedupeProducts(products);
}

export async function liveFetchProductById(productId: string): Promise<StructuredProduct | null> {
  const gid = productId.startsWith("gid://") ? productId : `gid://shopify/Product/${productId}`;
  const data = await shopifyGraphql<{ product: GqlProductNode | null }>(GET_PRODUCT_QUERY, { id: gid });
  return data.product ? mapGqlProduct(data.product) : null;
}

/** Run multiple live Shopify queries in parallel and merge (no cache). */
export async function liveSearchMulti(queries: string[]): Promise<StructuredProduct[]> {
  const uniqueQueries = [...new Set(queries.filter(Boolean))];
  const batches = await Promise.all(
    uniqueQueries.map(async (q) => {
      try {
        const [byProduct, byVariant] = await Promise.all([
          liveSearchProducts(q, 25),
          liveSearchVariants(q),
        ]);
        return [...byProduct, ...byVariant];
      } catch (err) {
        logger.warn("shopify_live_query_failed", {
          query: q,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    }),
  );
  return dedupeProducts(batches.flat());
}
