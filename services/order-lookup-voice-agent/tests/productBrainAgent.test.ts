import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleProductBrainTurn } from "../src/agents/productBrainAgent.js";
import { clearAllCustomerMemories } from "../src/memory/customerMemoryStore.js";
import { clearProductCache, STORE_NOT_FOUND_MESSAGE } from "../src/tools/shopifyProductTools.js";
import { mockLiveShopifyFetch } from "./helpers/mockLiveShopify.js";

vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: "We have Harry Potter in stock right now." } }],
        })),
      },
    };
  }
  return { default: MockOpenAI };
});

describe("productBrainAgent", () => {
  beforeEach(() => {
    clearAllCustomerMemories();
    clearProductCache();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('handles "Harry Potter book" with grounded live search speech', async () => {
    mockLiveShopifyFetch([
      {
        id: "1",
        title: "Harry Potter and the Sorcerer's Stone",
        handle: "hp1",
        productType: "Book",
        vendor: "Scholastic",
        tags: ["fiction", "fantasy"],
        variants: [{ id: "10", sku: "HP1", price: "12.99", inStock: true, inventoryQuantity: 5 }],
      },
      {
        id: "99",
        title: "Test Book",
        handle: "test-book",
        productType: "Book",
        vendor: "Pub",
        tags: [],
        isbns: ["9781234567890"],
        variants: [
          {
            id: "1",
            sku: "9781234567890",
            barcode: "9781234567890",
            price: "15.00",
            inStock: true,
            inventoryQuantity: 2,
          },
        ],
      },
    ]);

    const result = await handleProductBrainTurn({
      callSid: "CA_HP",
      userMessage: "I want Harry Potter book",
      intent: "product_search",
    });

    expect(result.products.length).toBeGreaterThan(0);
    expect(result.speech).toMatch(/Harry Potter|have|stock/i);
    expect(result.speech).not.toMatch(/no results found/i);
  });

  it("handles ISBN lookup from live Shopify data", async () => {
    mockLiveShopifyFetch([
      {
        id: "1",
        title: "Harry Potter and the Prisoner of Azkaban",
        handle: "hp-azkaban",
        productType: "Book",
        vendor: "J.K. Rowling",
        tags: ["fiction"],
        isbns: ["9783161484100"],
        variants: [
          {
            id: "10",
            sku: "9783161484100",
            barcode: "9783161484100",
            price: "14.99",
            inStock: true,
            inventoryQuantity: 4,
          },
        ],
      },
    ]);

    const result = await handleProductBrainTurn({
      callSid: "CA_ISBN",
      userMessage: "ISBN 9783161484100",
      intent: "isbn_query",
    });

    expect(result.products.length).toBeGreaterThan(0);
    expect(result.products[0]?.title).toMatch(/Azkaban/i);
    expect(result.speech).toBeTruthy();
  });

  it("says store-not-found when live Shopify returns nothing", async () => {
    mockLiveShopifyFetch([]);

    const result = await handleProductBrainTurn({
      callSid: "CA_NONE",
      userMessage: "Looking for Imaginary Book Title",
      intent: "product_search",
    });

    expect(result.products).toHaveLength(0);
    expect(result.speech).toMatch(new RegExp(STORE_NOT_FOUND_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  });
});
