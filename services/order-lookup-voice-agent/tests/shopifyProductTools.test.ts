import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearProductCache,
  extractIsbnFromSpeech,
  normalizeIsbn,
  searchProductByTitle,
} from "../src/tools/shopifyProductTools.js";

describe("shopifyProductTools", () => {
  beforeEach(() => {
    clearProductCache();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes ISBN formats", () => {
    expect(normalizeIsbn("978-0-123456-78-9")).toBe("9780123456789");
  });

  it("extracts ISBN from speech", () => {
    expect(extractIsbnFromSpeech("ISBN 9781234567890")).toBe("9781234567890");
  });

  it("fuzzy title search returns ranked products", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          products: [
            {
              id: 1,
              title: "Harry Potter and the Sorcerer's Stone",
              handle: "harry-potter-1",
              product_type: "Book",
              vendor: "Scholastic",
              tags: "fiction,fantasy",
              variants: [{ id: 10, price: "12.99", inventory_quantity: 5, sku: "HP1" }],
            },
            {
              id: 2,
              title: "Cooking for Beginners",
              handle: "cooking",
              product_type: "Book",
              vendor: "Other",
              tags: "cooking",
              variants: [{ id: 11, price: "9.99", inventory_quantity: 2 }],
            },
          ],
        }),
      }),
    );

    const result = await searchProductByTitle("Harry Potter");
    expect(result.status).toBe("found");
    expect(result.products[0]?.title).toMatch(/Harry Potter/i);
  });
});
