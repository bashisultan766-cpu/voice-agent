import { describe, expect, it } from "vitest";
import {
  buildDraftOrderLinePayload,
  createShopifyDraftOrder,
} from "../src/adapters/shopifyStorefrontAdapter.js";
import { parseVariantGid, isIsbnLikeId } from "../src/utils/shopifyGid.js";
import { shopifyGraphql } from "../src/tools/shopifyLiveSearch.js";
import { vi } from "vitest";

vi.mock("../src/tools/shopifyLiveSearch.js", () => ({
  shopifyGraphql: vi.fn(),
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

describe("shopifyGid", () => {
  it("rejects ISBN digits masquerading as variant ids", () => {
    expect(isIsbnLikeId("9780692089705")).toBe(true);
    expect(parseVariantGid("9780692089705")).toBeNull();
    expect(parseVariantGid("gid://shopify/ProductVariant/9780692089705")).toBeNull();
  });

  it("accepts real ProductVariant GIDs", () => {
    expect(parseVariantGid("gid://shopify/ProductVariant/40123456789012")).toBe(
      "gid://shopify/ProductVariant/40123456789012",
    );
  });
});

describe("buildDraftOrderLinePayload", () => {
  it("uses variantId when a valid GID is provided", () => {
    expect(
      buildDraftOrderLinePayload({
        quantity: 1,
        variantId: "gid://shopify/ProductVariant/40123456789012",
      }),
    ).toEqual({
      variantId: "gid://shopify/ProductVariant/40123456789012",
      quantity: 1,
    });
  });

  it("falls back to custom line item when only ISBN is available", () => {
    expect(
      buildDraftOrderLinePayload({
        quantity: 2,
        variantId: "9780692089705",
        title: "The Great Gatsby",
        originalUnitPrice: "12.99",
      }),
    ).toEqual({
      title: "The Great Gatsby",
      quantity: 2,
      originalUnitPrice: "12.99",
    });
  });

  it("normalizes currency strings for custom line items", () => {
    expect(
      buildDraftOrderLinePayload({
        quantity: 50,
        title: "Bulk Order Book",
        originalUnitPrice: "$10",
      }),
    ).toEqual({
      title: "Bulk Order Book",
      quantity: 50,
      originalUnitPrice: "10.00",
    });
  });
});

describe("createShopifyDraftOrder", () => {
  it("returns structured failure for Shopify userErrors without throwing", async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({
      draftOrderCreate: {
        draftOrder: null,
        userErrors: [
          {
            field: ["lineItems", "0", "variantId"],
            message: "Product with ID 9780692089705 is no longer available.",
          },
        ],
      },
    });

    const result = await createShopifyDraftOrder(
      [
        {
          quantity: 1,
          variantId: "gid://shopify/ProductVariant/40123456789012",
          title: "Test Book",
          originalUnitPrice: "9.99",
        },
      ],
      "customer@example.com",
      "Jane Doe",
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Product with ID 9780692089705 is no longer available.");
  });
});
