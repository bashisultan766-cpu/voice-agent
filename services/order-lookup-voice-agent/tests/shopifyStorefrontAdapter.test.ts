import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOrderStatus,
  mapGqlOrderNode,
  parseGraphqlThrottle,
  searchByISBN,
  searchByTitle,
} from "../src/adapters/shopifyStorefrontAdapter.js";
import { shopifyGraphql } from "../src/tools/shopifyLiveSearch.js";
import { resetShopifyCircuitBreaker } from "../src/platform/circuitBreaker.js";

vi.mock("../src/tools/shopifyLiveSearch.js", () => ({
  shopifyGraphql: vi.fn(),
  mapGqlProduct: vi.fn((node: {
    id: string;
    title: string;
    handle: string;
    tags: string[];
    vendor: string;
    productType: string;
    variants: { edges: Array<{ node: { id: string; sku: string; barcode: string; price: string; inventoryQuantity: number } }> };
  }) => ({
    id: node.id.replace("gid://shopify/Product/", ""),
    title: node.title,
    handle: node.handle,
    productType: node.productType,
    vendor: node.vendor,
    tags: node.tags,
    variants: (node.variants?.edges ?? []).map(({ node: v }) => ({
      id: v.id,
      sku: v.sku,
      barcode: v.barcode,
      price: v.price,
      inStock: v.inventoryQuantity > 0,
      inventoryQuantity: v.inventoryQuantity,
    })),
    isbns: [],
  })),
}));

vi.mock("../src/platform/circuitBreaker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/platform/circuitBreaker.js")>();
  return {
    ...actual,
    withShopifyCircuitBreaker: vi.fn(
      async (_callSid: string, _op: string, work: () => Promise<unknown>) => work(),
    ),
  };
});

import { ShopifyThrottledError } from "../src/platform/shopifyErrors.js";
import {
  ORDER_21698_F1_EXPECTED,
  ORDER_21698_F1_GQL_NODE,
} from "./fixtures/order21698F1.js";

const SAMPLE_ISBN = "9783161484100";

const SAMPLE_PRODUCT_NODE = {
  id: "gid://shopify/Product/1001",
  title: "Sample Book",
  handle: "sample-book",
  tags: [],
  vendor: "Test Publisher",
  productType: "Book",
  variants: {
    edges: [
      {
        node: {
          id: "gid://shopify/ProductVariant/2001",
          sku: SAMPLE_ISBN,
          barcode: SAMPLE_ISBN,
          title: "Default",
          price: "14.99",
          inventoryQuantity: 12,
        },
      },
    ],
  },
  metafields: { edges: [] },
};

describe("parseGraphqlThrottle", () => {
  it("detects THROTTLED extension code", () => {
    const err = parseGraphqlThrottle([
      { message: "Rate limited", extensions: { code: "THROTTLED" } },
    ]);
    expect(err).toBeInstanceOf(ShopifyThrottledError);
  });

  it("returns null for non-throttle errors", () => {
    expect(parseGraphqlThrottle([{ message: "Access denied" }])).toBeNull();
  });
});

describe("getOrderStatus", () => {
  beforeEach(() => {
    vi.mocked(shopifyGraphql).mockReset();
    resetShopifyCircuitBreaker();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns invalid_format for short order numbers", async () => {
    const result = await getOrderStatus("12");
    expect(result.status).toBe("invalid_format");
    expect(shopifyGraphql).not.toHaveBeenCalled();
  });

  it("returns found with fulfillment, pricing, payment, and delivery estimate", async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({
      orders: {
        edges: [
          {
            node: {
              id: "gid://shopify/Order/1",
              name: "#12345",
              email: "jane@example.com",
              displayFulfillmentStatus: "FULFILLED",
              displayFinancialStatus: "PAID",
              customer: { firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
              subtotalPriceSet: { shopMoney: { amount: "40.00", currencyCode: "USD" } },
              totalPriceSet: { shopMoney: { amount: "45.99", currencyCode: "USD" } },
              totalShippingPriceSet: { shopMoney: { amount: "5.99", currencyCode: "USD" } },
              lineItems: {
                edges: [{ node: { title: "Sample Book", quantity: 2 } }],
              },
              customAttributes: [],
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
    });

    const result = await getOrderStatus("12345");
    expect(result.status).toBe("found");
    expect(result.orderNumber).toBe("#12345");
    expect(result.customerName).toBe("Jane Doe");
    expect(result.subtotalAmount).toBe("40.00 USD");
    expect(result.shippingFee).toBe("5.99 USD");
    expect(result.lineItems).toEqual([{ title: "Sample Book", quantity: 2 }]);
    expect(result.cardLast4).toBe("4242");
    expect(result.fulfillmentStatus).toBe("Delivered");
    expect(result.trackingUrl).toBe("https://track.example/9400");
    expect(result.trackingNumber).toBe("9400");
    expect(result.trackingCompany).toBe("USPS");
    expect(result.estimatedDeliveryDays).toBeGreaterThanOrEqual(0);
  });

  it("returns refund email from custom attributes when refunded", async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({
      orders: {
        edges: [
          {
            node: {
              id: "gid://shopify/Order/2",
              name: "#54321",
              email: "caller@example.com",
              displayFinancialStatus: "REFUNDED",
              customAttributes: [{ key: "refund_email", value: "refunds@example.com" }],
              refunds: [{ note: "Customer requested cancellation" }],
              lineItems: { edges: [] },
              fulfillments: [],
            },
          },
        ],
      },
    });

    const result = await getOrderStatus("54321");
    expect(result.status).toBe("found");
    expect(result.refundStatus).toBe("REFUNDED");
    expect(result.refundReason).toBe("Customer requested cancellation");
    expect(result.refundEmail).toBe("refunds@example.com");
  });

  it("does not fall back to billing email when timeline has no refund notification", async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({
      orders: {
        edges: [
          {
            node: {
              id: "gid://shopify/Order/3",
              name: "#54321",
              email: "billing@gmail.com",
              displayFinancialStatus: "REFUNDED",
              customAttributes: [],
              events: { edges: [] },
              refunds: [{ note: "Cancelled" }],
              lineItems: { edges: [] },
              fulfillments: [],
            },
          },
        ],
      },
    });

    const result = await getOrderStatus("54321");
    expect(result.refundNotificationEmail).toBeUndefined();
    expect(result.refundEmail).toBeUndefined();
  });

  it("maps order #21698-F1 fixture with timeline email and PayPal gateway", () => {
    const mapped = mapGqlOrderNode(ORDER_21698_F1_GQL_NODE);
    expect(mapped.customerName).toBe(ORDER_21698_F1_EXPECTED.customerName);
    expect(mapped.refundNotificationEmail).toBe(ORDER_21698_F1_EXPECTED.refundNotificationEmail);
    expect(mapped.refundEmail).toBe(ORDER_21698_F1_EXPECTED.refundNotificationEmail);
    expect(mapped.refundReason).toBe(ORDER_21698_F1_EXPECTED.refundReason);
    expect(mapped.refundAmount).toBe(ORDER_21698_F1_EXPECTED.refundAmount);
    expect(mapped.paymentGateway).toBe(ORDER_21698_F1_EXPECTED.paymentGateway);
    expect(mapped.cardLast4).toBeUndefined();
    expect(mapped.refundNotificationEmail).not.toBe("joel.moore@gmail.com");
    expect(mapped.lineItems).toEqual(ORDER_21698_F1_EXPECTED.lineItems);
  });

  it("finds #21698-F1 when caller provides base number 21698", async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({
      orders: {
        edges: [{ node: ORDER_21698_F1_GQL_NODE }],
      },
    });

    const result = await getOrderStatus("21698");
    expect(result.status).toBe("found");
    expect(result.orderNumber).toBe("#21698-F1");
    expect(result.customerName).toBe("Joel Moore");
  });

  it("finds order when caller provides full suffix number 21698-F1", async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({
      orders: {
        edges: [{ node: ORDER_21698_F1_GQL_NODE }],
      },
    });

    const result = await getOrderStatus("21698-F1");
    expect(result.status).toBe("found");
    expect(result.orderNumber).toBe("#21698-F1");
  });

  it("returns not_found when Shopify has no match", async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({ orders: { edges: [] } });

    const result = await getOrderStatus("99999");
    expect(result.status).toBe("not_found");
    expect(result.searchedNumber).toBe("#99999");
    expect(result.error).toBe("No exact match found in Shopify.");
  });

  it("uses wildcard name query for flexible order number lookup", async () => {
    vi.mocked(shopifyGraphql).mockImplementation(async (_query, vars) => {
      const search = (vars as { query: string }).query;
      if (search.endsWith("*")) {
        return { orders: { edges: [{ node: ORDER_21698_F1_GQL_NODE }] } };
      }
      return { orders: { edges: [] } };
    });

    const result = await getOrderStatus("21698");
    expect(result.status).toBe("found");
    expect(result.orderNumber).toBe("#21698-F1");

    const queries = vi.mocked(shopifyGraphql).mock.calls.map(
      (call) => (call[1] as { query: string }).query,
    );
    expect(queries.some((q) => q.endsWith("*"))).toBe(true);
  });

  it("returns throttled when GraphQL rate-limits", async () => {
    vi.mocked(shopifyGraphql).mockRejectedValue(new ShopifyThrottledError());

    const result = await getOrderStatus("12345");
    expect(result.status).toBe("throttled");
  });

  it("returns system_maintenance on network failure", async () => {
    vi.mocked(shopifyGraphql).mockRejectedValue(new Error("network down"));

    const result = await getOrderStatus("12345");
    expect(result.status).toBe("system_maintenance");
  });
});

describe("searchByISBN", () => {
  beforeEach(() => {
    vi.mocked(shopifyGraphql).mockReset();
    resetShopifyCircuitBreaker();
  });

  it("returns invalid_format for bad ISBN", async () => {
    const result = await searchByISBN("123");
    expect(result.status).toBe("invalid_format");
  });

  it("returns book name, price, and stock quantity", async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({
      products: { edges: [{ node: SAMPLE_PRODUCT_NODE }] },
    });

    const result = await searchByISBN(SAMPLE_ISBN);
    expect(result.status).toBe("found");
    expect(result.bookName).toBe("Sample Book");
    expect(result.price).toBe("14.99");
    expect(result.inStock).toBe(true);
    expect(result.quantity).toBe(12);
  });

  it("returns not_found when catalog is empty", async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({ products: { edges: [] } });

    const result = await searchByISBN(SAMPLE_ISBN);
    expect(result.status).toBe("not_found");
  });

  it("returns throttled on rate limit", async () => {
    vi.mocked(shopifyGraphql).mockRejectedValue(new ShopifyThrottledError());

    const result = await searchByISBN(SAMPLE_ISBN);
    expect(result.status).toBe("throttled");
  });
});

describe("searchByTitle", () => {
  beforeEach(() => {
    vi.mocked(shopifyGraphql).mockReset();
    resetShopifyCircuitBreaker();
  });

  it("returns invalid_format for empty title", async () => {
    const result = await searchByTitle(" ");
    expect(result.status).toBe("invalid_format");
  });

  it("returns top fuzzy match with availability", async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({
      products: {
        edges: [
          { node: { ...SAMPLE_PRODUCT_NODE, title: "Harry Potter and the Sorcerer's Stone" } },
          { node: { ...SAMPLE_PRODUCT_NODE, id: "gid://shopify/Product/1002", title: "Other Book" } },
        ],
      },
    });

    const result = await searchByTitle("Harry Potter Sorcerer");
    expect(result.status).toBe("found");
    expect(result.bookName).toContain("Harry Potter");
    expect(result.price).toBe("14.99");
    expect(result.inStock).toBe(true);
  });

  it("returns not_found when no products match", async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({ products: { edges: [] } });

    const result = await searchByTitle("Obscure Title XYZ");
    expect(result.status).toBe("not_found");
  });

  it("returns system_maintenance when GraphQL fails", async () => {
    vi.mocked(shopifyGraphql).mockRejectedValue(new Error("graphql exploded"));

    const result = await searchByTitle("Some Book");
    expect(result.status).toBe("system_maintenance");
  });
});
