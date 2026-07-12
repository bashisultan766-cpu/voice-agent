/**
 * Internal Shopify GraphQL search — NOT a public tool entry point.
 * All production search MUST go through shopifyProductTools (guarded).
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  isShopifyThrottleError,
  parseShopifyGraphqlErrors,
  ShopifyAuthError,
  ShopifyThrottledError,
} from "../platform/shopifyErrors.js";
import { normalizeIsbn } from "../utils/productSearchNormalize.js";
import type { StructuredProduct } from "../types/product.js";
import { getShopifyAdminAccessToken } from "../platform/shopifyAccessToken.js";
import { ensureShopifyProductScopes, SHOPIFY_MISSING_PRODUCTS_SCOPE_ERROR } from "./shopifyScopeCheck.js";
import { maskShopifyToken } from "../utils/security.js";

export interface GqlMetafieldNode {
  namespace: string;
  key: string;
  value: string;
}

export interface GqlProductNode {
  id: string;
  title: string;
  handle: string;
  productType: string;
  vendor: string;
  tags: string[];
  variants: {
    edges: Array<{
      node: {
        id: string;
        sku: string;
        barcode: string;
        title: string;
        price: string;
        inventoryQuantity: number;
      };
    }>;
  };
  metafields?: {
    edges: Array<{ node: GqlMetafieldNode }>;
  };
}

const VARIANT_FIELDS = `
  id
  sku
  barcode
  title
  price
  inventoryQuantity
`;

const PRODUCT_NODE_FIELDS = `
  id
  title
  handle
  tags
  vendor
  productType
  variants(first: 10) {
    edges {
      node { ${VARIANT_FIELDS} }
    }
  }
  metafields(first: 10) {
    edges {
      node {
        namespace
        key
        value
      }
    }
  }
`;

const PRODUCT_NODE_FIELDS_BASIC = `
  id
  title
  handle
  tags
  vendor
  productType
  variants(first: 10) {
    edges {
      node { ${VARIANT_FIELDS} }
    }
  }
`;

const PRODUCT_SEARCH_QUERY = `query ProductSearch($query: String!) {
  products(first: 50, query: $query) {
    edges {
      node { ${PRODUCT_NODE_FIELDS} }
    }
  }
}`;

const PRODUCT_SEARCH_QUERY_BASIC = `query ProductSearch($query: String!) {
  products(first: 50, query: $query) {
    edges {
      node { ${PRODUCT_NODE_FIELDS_BASIC} }
    }
  }
}`;

const GET_PRODUCT_QUERY = `query LiveGetProduct($id: ID!) {
  product(id: $id) { ${PRODUCT_NODE_FIELDS} }
}`;

const GET_PRODUCT_QUERY_BASIC = `query LiveGetProduct($id: ID!) {
  product(id: $id) { ${PRODUCT_NODE_FIELDS_BASIC} }
}`;

const SEARCH_VARIANTS_QUERY = `query LiveSearchVariants($query: String!) {
  productVariants(first: 25, query: $query) {
    edges {
      node {
        id
        sku
        barcode
        product { ${PRODUCT_NODE_FIELDS} }
      }
    }
  }
}`;

const SEARCH_VARIANTS_QUERY_BASIC = `query LiveSearchVariants($query: String!) {
  productVariants(first: 25, query: $query) {
    edges {
      node {
        id
        sku
        barcode
        product { ${PRODUCT_NODE_FIELDS_BASIC} }
      }
    }
  }
}`;

function shopifyBaseUrl(): string {
  const cfg = getConfig();
  const domain = cfg.SHOPIFY_SHOP_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}/admin/api/${cfg.SHOPIFY_API_VERSION}`;
}

function isMetafieldGraphqlError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /metafield/i.test(message);
}

export async function shopifyGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const cfg = getConfig();
  const accessToken = await getShopifyAdminAccessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.SHOPIFY_TIMEOUT_MS);

  const started = Date.now();
  try {
    console.log("[shopify_graphql]", query);
    const res = await fetch(`${shopifyBaseUrl()}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        logger.error("SHOPIFY_AUTH_FAILED: Invalid Token or Missing Scopes", {
          httpStatus: res.status,
          token: maskShopifyToken(accessToken),
          shop: cfg.SHOPIFY_SHOP_DOMAIN,
        });
        throw new ShopifyAuthError(res.status);
      }
      throw new Error(`shopify_graphql_http_${res.status}`);
    }

    const body = (await res.json()) as { data?: T; errors?: unknown[] };
    if (body.errors?.length) {
      const throttled = parseShopifyGraphqlErrors(body.errors);
      if (throttled) throw throttled;

      const authDenied = (body.errors as Array<{ message?: string; extensions?: { code?: string } }>).some(
        (e) =>
          /access denied|unauthorized|invalid api key|invalid access token/i.test(
            e.message ?? "",
          ) || e.extensions?.code === "ACCESS_DENIED",
      );
      if (authDenied) {
        logger.error("SHOPIFY_AUTH_FAILED: Invalid Token or Missing Scopes", {
          token: maskShopifyToken(accessToken),
          shop: cfg.SHOPIFY_SHOP_DOMAIN,
        });
        throw new ShopifyAuthError(403);
      }

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

function extractIsbnsFromMetafields(node: GqlProductNode): string[] {
  const isbns = new Set<string>();
  for (const { node: mf } of node.metafields?.edges ?? []) {
    if (!mf?.value) continue;
    const key = mf.key?.toLowerCase() ?? "";
    const ns = mf.namespace?.toLowerCase() ?? "";
    if (key === "isbn" || key.includes("isbn") || ns.includes("book")) {
      isbns.add(normalizeIsbn(mf.value));
    }
  }
  return [...isbns];
}

export function mapGqlProduct(node: GqlProductNode): StructuredProduct {
  const isbns = extractIsbnsFromMetafields(node);

  return {
    id: node.id.replace("gid://shopify/Product/", ""),
    title: node.title,
    handle: node.handle,
    productType: node.productType ?? "",
    vendor: node.vendor ?? "",
    author: node.vendor || undefined,
    tags: node.tags ?? [],
    isbns,
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

async function graphqlProductsSearch(
  shopifyQuery: string,
  useMetafields: boolean,
): Promise<StructuredProduct[]> {
  const gql = useMetafields ? PRODUCT_SEARCH_QUERY : PRODUCT_SEARCH_QUERY_BASIC;
  const data = await shopifyGraphql<{
    products: { edges: Array<{ node: GqlProductNode }> };
  }>(gql, { query: shopifyQuery });

  return dedupeProducts((data.products?.edges ?? []).map(({ node }) => mapGqlProduct(node)));
}

/**
 * Single authoritative Shopify product search.
 * Verifies read_products scope, then runs ProductSearch GraphQL.
 */
export async function searchShopifyProducts(shopifyQuery: string): Promise<StructuredProduct[]> {
  const q = shopifyQuery.trim();
  if (!q) return [];

  try {
    await ensureShopifyProductScopes();
  } catch (err) {
    logger.warn("shopify_scope_check_failed", {
      query: q,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  try {
    return await graphqlProductsSearch(q, true);
  } catch (err) {
    if (isShopifyThrottleError(err)) throw err;
    if (!isMetafieldGraphqlError(err)) {
      logger.warn("shopify_product_search_failed", {
        query: q,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
    logger.warn("shopify_product_search_metafield_fallback", {
      query: q,
      error: err instanceof Error ? err.message : String(err),
    });
    return graphqlProductsSearch(q, false);
  }
}

/** Live variant search — supplemental SKU / barcode path. */
export async function liveSearchVariants(shopifyQuery: string): Promise<StructuredProduct[]> {
  await ensureShopifyProductScopes();

  try {
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
  } catch (err) {
    if (isShopifyThrottleError(err)) throw err;
    if (!isMetafieldGraphqlError(err)) throw err;

    const data = await shopifyGraphql<{
      productVariants: {
        edges: Array<{ node: { product: GqlProductNode } }>;
      };
    }>(SEARCH_VARIANTS_QUERY_BASIC, { query: shopifyQuery });

    const products = (data.productVariants?.edges ?? [])
      .map(({ node }) => node.product)
      .filter(Boolean)
      .map((node) => mapGqlProduct(node));

    return dedupeProducts(products);
  }
}

export async function liveFetchProductById(productId: string): Promise<StructuredProduct | null> {
  await ensureShopifyProductScopes();

  const gid = productId.startsWith("gid://") ? productId : `gid://shopify/Product/${productId}`;

  try {
    const data = await shopifyGraphql<{ product: GqlProductNode | null }>(GET_PRODUCT_QUERY, { id: gid });
    return data.product ? mapGqlProduct(data.product) : null;
  } catch (err) {
    if (isShopifyThrottleError(err)) throw err;
    if (!isMetafieldGraphqlError(err)) throw err;
    const data = await shopifyGraphql<{ product: GqlProductNode | null }>(GET_PRODUCT_QUERY_BASIC, { id: gid });
    return data.product ? mapGqlProduct(data.product) : null;
  }
}

/** Run multiple live Shopify queries in parallel and merge (no cache). */
export async function liveSearchMulti(queries: string[]): Promise<StructuredProduct[]> {
  const uniqueQueries = [...new Set(queries.filter(Boolean))];
  const batches = await Promise.all(
    uniqueQueries.map(async (q) => {
      try {
        const [byProduct, byVariant] = await Promise.all([
          searchShopifyProducts(q),
          liveSearchVariants(q),
        ]);
        return [...byProduct, ...byVariant];
      } catch (err) {
        if (isShopifyThrottleError(err)) throw err;
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

/** @deprecated Use searchShopifyProducts */
export const liveSearchProducts = searchShopifyProducts;

export { SHOPIFY_MISSING_PRODUCTS_SCOPE_ERROR };
