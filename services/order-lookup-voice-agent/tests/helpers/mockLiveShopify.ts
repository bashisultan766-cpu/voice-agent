import { vi } from "vitest";
import type { StructuredProduct } from "../../src/types/product.js";

function gqlNodeFromProduct(p: StructuredProduct) {
  return {
    id: `gid://shopify/Product/${p.id}`,
    title: p.title,
    handle: p.handle,
    productType: p.productType,
    vendor: p.vendor,
    tags: p.tags,
    description: p.descriptionSnippet ?? "",
    isbnCustom: p.isbns?.[0] ? { value: p.isbns[0] } : null,
    isbnBooks: null,
    isbnProduct: null,
    variants: {
      edges: p.variants.map((v) => ({
        node: {
          id: `gid://shopify/ProductVariant/${v.id}`,
          sku: v.sku ?? "",
          barcode: v.barcode ?? "",
          price: v.price,
          inventoryQuantity: v.inventoryQuantity,
        },
      })),
    },
  };
}

function matchesShopifyQuery(query: string, product: StructuredProduct): boolean {
  const q = query.toLowerCase();
  const haystack = `${product.title} ${product.productType} ${product.tags.join(" ")} ${product.vendor} ${product.isbns?.join(" ") ?? ""} ${product.variants.map((v) => `${v.sku ?? ""} ${v.barcode ?? ""}`).join(" ")}`.toLowerCase();

  if (q.includes(" or ")) {
    return q.split(" or ").some((part) => matchesShopifyQuery(part.trim(), product));
  }
  if (q.startsWith("barcode:")) {
    const val = q.slice("barcode:".length).replace(/\*/g, "");
    return product.variants.some((v) => (v.barcode ?? "").toLowerCase().includes(val));
  }
  if (q.startsWith("sku:")) {
    const val = q.slice("sku:".length).replace(/\*/g, "");
    return product.variants.some((v) => (v.sku ?? "").toLowerCase().includes(val));
  }
  if (q.startsWith("title:")) {
    const val = q.slice("title:".length).replace(/\*/g, "");
    return product.title.toLowerCase().includes(val);
  }
  if (q.startsWith("product_type:")) {
    const val = q.slice("product_type:".length).replace(/'/g, "").replace(/\*/g, "");
    return product.productType.toLowerCase().includes(val);
  }
  if (q.startsWith("vendor:")) {
    const val = q.slice("vendor:".length).replace(/'/g, "").replace(/\*/g, "");
    return product.vendor.toLowerCase().includes(val);
  }
  if (q.startsWith("tag:")) {
    const val = q.slice("tag:".length).replace(/'/g, "").replace(/\*/g, "");
    return product.tags.some((tag) => tag.toLowerCase().includes(val));
  }

  return haystack.includes(q.replace(/\*/g, ""));
}

export function mockLiveShopifyFetch(catalog: StructuredProduct[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const query = body.query ?? "";
      const variables = body.variables ?? {};

      if (query.includes("LiveGetProduct")) {
        const rawId = String(variables.id ?? "");
        const id = rawId.replace("gid://shopify/Product/", "");
        const product = catalog.find((p) => p.id === id);
        return {
          ok: true,
          json: async () => ({
            data: { product: product ? gqlNodeFromProduct(product) : null },
          }),
        };
      }

      if (query.includes("productVariants")) {
        const shopifyQuery = String(variables.query ?? "");
        const matches = catalog.filter((p) =>
          p.variants.some((v) => {
            const sku = (v.sku ?? "").toLowerCase();
            const barcode = (v.barcode ?? "").toLowerCase();
            const q = shopifyQuery.toLowerCase();
            return sku.includes(q.replace(/\*/g, "")) || barcode.includes(q.replace(/\*/g, ""));
          }),
        );
        return {
          ok: true,
          json: async () => ({
            data: {
              productVariants: {
                edges: matches.flatMap((p) =>
                  p.variants.map((v) => ({
                    node: {
                      id: `gid://shopify/ProductVariant/${v.id}`,
                      sku: v.sku ?? "",
                      barcode: v.barcode ?? "",
                      product: gqlNodeFromProduct(p),
                    },
                  })),
                ),
              },
            },
          }),
        };
      }

      if (query.includes("products")) {
        const shopifyQuery = String(variables.query ?? "");
        const matches = catalog.filter((p) => matchesShopifyQuery(shopifyQuery, p));
        return {
          ok: true,
          json: async () => ({
            data: {
              products: {
                edges: matches.map((p) => ({ node: gqlNodeFromProduct(p) })),
              },
            },
          }),
        };
      }

      return { ok: true, json: async () => ({ data: {} }) };
    }),
  );
}
