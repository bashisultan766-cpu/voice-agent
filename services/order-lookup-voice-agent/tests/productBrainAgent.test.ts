import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleProductBrainTurn } from "../src/agents/productBrainAgent.js";
import { clearAllCustomerMemories } from "../src/memory/customerMemoryStore.js";
import { clearProductCache } from "../src/tools/shopifyProductTools.js";

function mockShopifyFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const target = String(url);
      if (!target.includes("graphql")) {
        return { ok: true, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            products: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [
                {
                  node: {
                    id: "gid://shopify/Product/1",
                    title: "Harry Potter and the Sorcerer's Stone",
                    handle: "hp1",
                    productType: "Book",
                    vendor: "Scholastic",
                    tags: ["fiction", "fantasy"],
                    description: "A fantasy book",
                    isbnCustom: null,
                    isbnBooks: null,
                    isbnProduct: null,
                    variants: {
                      edges: [
                        {
                          node: {
                            id: "gid://shopify/ProductVariant/10",
                            sku: "HP1",
                            barcode: "",
                            price: "12.99",
                            inventoryQuantity: 5,
                          },
                        },
                      ],
                    },
                  },
                },
                {
                  node: {
                    id: "gid://shopify/Product/99",
                    title: "Test Book",
                    handle: "test-book",
                    productType: "Book",
                    vendor: "Pub",
                    tags: [],
                    description: "A test book",
                    isbnCustom: { value: "9781234567890" },
                    isbnBooks: null,
                    isbnProduct: null,
                    variants: {
                      edges: [
                        {
                          node: {
                            id: "gid://shopify/ProductVariant/1",
                            sku: "9781234567890",
                            barcode: "9781234567890",
                            price: "15.00",
                            inventoryQuantity: 2,
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        }),
      };
    }),
  );
}

describe("productBrainAgent", () => {
  beforeEach(() => {
    clearAllCustomerMemories();
    clearProductCache();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('handles "Harry Potter book" with grounded fallback speech', async () => {
    mockShopifyFetch();

    const result = await handleProductBrainTurn({
      callSid: "CA_HP",
      userMessage: "I want Harry Potter book",
      intent: "product_search",
    });

    expect(result.products.length).toBeGreaterThan(0);
    expect(result.speech).toMatch(/Harry Potter|have|stock|close/i);
    expect(result.speech).not.toMatch(/no results found/i);
  });

  it("handles ISBN lookup", async () => {
    mockShopifyFetch();

    const result = await handleProductBrainTurn({
      callSid: "CA_ISBN",
      userMessage: "ISBN 9781234567890",
      intent: "isbn_query",
    });

    expect(result.products.length).toBeGreaterThan(0);
    expect(result.speech).toBeTruthy();
  });
});
