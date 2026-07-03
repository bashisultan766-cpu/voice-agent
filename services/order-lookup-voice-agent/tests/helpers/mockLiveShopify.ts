import { vi } from "vitest";
import type { StructuredProduct } from "../../src/types/product.js";

function gqlNodeFromProduct(p: StructuredProduct) {
  const metafieldEdges = (p.isbns ?? []).map((isbn) => ({
    node: { namespace: "custom", key: "isbn", value: isbn },
  }));

  return {
    id: `gid://shopify/Product/${p.id}`,
    title: p.title,
    handle: p.handle,
    productType: p.productType,
    vendor: p.vendor,
    tags: p.tags,
    variants: {
      edges: p.variants.map((v) => ({
        node: {
          id: `gid://shopify/ProductVariant/${v.id}`,
          sku: v.sku ?? "",
          barcode: v.barcode ?? "",
          title: p.title,
          price: v.price,
          inventoryQuantity: v.inventoryQuantity,
        },
      })),
    },
    metafields: { edges: metafieldEdges },
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
  if (q.startsWith("metafields.")) {
    const val = q.split(":").slice(1).join(":").replace(/\*/g, "");
    return (product.isbns ?? []).some((isbn) => isbn.toLowerCase().includes(val));
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

function scopeMockResponse() {
  return {
    ok: true,
    json: async () => ({ access_scopes: [{ handle: "read_products" }] }),
  };
}

export function mockLiveShopifyFetch(catalog: StructuredProduct[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);

      if (target.includes("/shop.json")) {
        return { ok: true, json: async () => ({ shop: { name: "Test Shop" } }) };
      }
      if (target.includes("access_scopes.json")) {
        return scopeMockResponse();
      }

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

      if (
        query.includes("ProductSearch") ||
        query.includes("ProductFulfillmentSearch") ||
        query.includes("products")
      ) {
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

      if (query.includes("FulfillmentOrderLookup") || query.includes("orders(first:")) {
        const shopifyQuery = String(variables.query ?? "");
        const orderMatch = shopifyQuery.match(/#?(\d{4,10})/);
        const orderNum = orderMatch?.[1];
        if (orderNum) {
          const product = catalog[0];
          return {
            ok: true,
            json: async () => ({
              data: {
                orders: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/Order/1",
                        name: `#${orderNum}`,
                        note: null,
                        displayFulfillmentStatus: "FULFILLED",
                        displayFinancialStatus: "PAID",
                        customer: { firstName: "Jane", lastName: "Doe" },
                        totalPriceSet: { shopMoney: { amount: "45.99", currencyCode: "USD" } },
                        totalShippingPriceSet: { shopMoney: { amount: "5.99", currencyCode: "USD" } },
                        lineItems: {
                          edges: product
                            ? [{ node: { title: product.title, quantity: 1 } }]
                            : [],
                        },
                        refunds: [],
                        transactions: [
                          {
                            gateway: "shopify_payments",
                            paymentDetails: { company: "Visa", number: "•••• 4242" },
                          },
                        ],
                        fulfillments: [
                          {
                            status: "SUCCESS",
                            displayStatus: "Delivered",
                            estimatedDeliveryAt: new Date(Date.now() + 2 * 86400000).toISOString(),
                            deliveredAt: null,
                            trackingInfo: [{ company: "USPS", number: "9400", url: "https://track.example/9400" }],
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ data: { orders: { edges: [] } } }) };
      }

      return { ok: true, json: async () => ({ data: {} }) };
    }),
  );
}

export function mockShopifyMissingProductScope(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes("/shop.json")) {
        return { ok: true, json: async () => ({ shop: { name: "Test Shop" } }) };
      }
      if (target.includes("access_scopes.json")) {
        return {
          ok: true,
          json: async () => ({ access_scopes: [{ handle: "read_orders" }] }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}
