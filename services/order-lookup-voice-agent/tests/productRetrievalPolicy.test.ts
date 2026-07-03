import { describe, expect, it } from "vitest";
import {
  buildProductSearchKey,
  filterValidatedProducts,
  isExplicitRepeatRequest,
  isNewTitleSearch,
  selectTitleSearchResults,
  validateProductIdentity,
} from "../src/agents/productRetrievalPolicy.js";
import { emptyProductMemory } from "../src/memory/callMemoryStore.js";
import type { StructuredProduct } from "../src/types/product.js";

const sample = (id: string, title: string, isbn?: string): StructuredProduct => ({
  id,
  title,
  handle: id,
  productType: "Book",
  vendor: "Test",
  tags: [],
  isbns: isbn ? [isbn] : [],
  variants: [{ id: `${id}-v`, sku: isbn, price: "9.99", inStock: true, inventoryQuantity: 1 }],
});

describe("productRetrievalPolicy", () => {
  it("detects explicit repeat requests", () => {
    expect(isExplicitRepeatRequest("look up that book again")).toBe(true);
    expect(isExplicitRepeatRequest("Harry Potter")).toBe(false);
  });

  it("builds stable search keys from memory", () => {
    expect(buildProductSearchKey({ isbn: "9783161484100", isbnCollected: true, titleCollected: false })).toBe(
      "isbn:9783161484100",
    );
    expect(
      buildProductSearchKey({ title: "Harry Potter", isbnCollected: false, titleCollected: true }),
    ).toBe("title:harry potter");
  });

  it("returns multiple candidates for ambiguous titles", () => {
    const products = [
      sample("1", "Harry Potter and the Prisoner of Azkaban"),
      sample("2", "Harry Potter and the Chamber of Secrets"),
    ];
    const result = selectTitleSearchResults(products, "Harry Potter");
    expect(result.mode).toBe("ambiguous");
    expect(result.products.length).toBe(2);
  });

  it("detects new title searches", () => {
    const memory = {
      ...emptyProductMemory(),
      title: "Dune",
      lastSearchKey: "title:harry potter",
      titleCollected: true,
    };
    expect(isNewTitleSearch(memory, "title:dune")).toBe(true);
  });

  it("rejects stale product id for new title searches", () => {
    const memory = {
      ...emptyProductMemory(),
      title: "Dune",
      lastSearchKey: "title:harry potter",
      lastResultProductId: "old-id",
      titleCollected: true,
    };
    const result = validateProductIdentity(sample("old-id", "Harry Potter"), {
      memory,
      explicitRepeat: false,
      forceFreshTitleQuery: true,
    }, "title");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("stale_product_id_for_new_title");
  });

  it("filters validated products for fresh title search", () => {
    const memory = {
      ...emptyProductMemory(),
      title: "Harry Potter",
      lastSearchKey: "title:imaginary",
      lastResultProductId: "stale",
      titleCollected: true,
    };
    const { accepted } = filterValidatedProducts(
      [sample("stale", "Old Book"), sample("new", "Harry Potter and the Prisoner of Azkaban")],
      { memory, explicitRepeat: false, forceFreshTitleQuery: true },
      "title",
    );
    expect(accepted.map((p) => p.id)).toEqual(["new"]);
  });
});
