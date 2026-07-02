import { describe, expect, it } from "vitest";
import {
  buildIsbnTruthQueries,
  buildTitleTruthQueries,
  truthSearchByIsbn,
  truthSearchByTitle,
} from "../src/tools/shopifyTruthSearch.js";
import type { StructuredProduct } from "../src/types/product.js";
import { mockLiveShopifyFetch } from "./helpers/mockLiveShopify.js";
import { afterEach, beforeEach, vi } from "vitest";
import { resetShopifyScopeCheck } from "../src/tools/shopifyScopeCheck.js";

const mockCatalog: StructuredProduct[] = [
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
];

describe("shopifyTruthSearch query builders", () => {
  it("builds ISBN queries with sku, barcode, and metafield OR syntax", () => {
    const queries = buildIsbnTruthQueries("9783161484100");
    expect(queries.some((q) => q.includes("sku:*9783161484100*"))).toBe(true);
    expect(queries.some((q) => q.includes("metafields.custom.isbn:*9783161484100*"))).toBe(true);
    expect(queries.some((q) => q.includes("metafields.books.isbn:*9783161484100*"))).toBe(true);
  });

  it("builds title queries as title:*token* OR title:*token*", () => {
    const queries = buildTitleTruthQueries("Harry Potter");
    expect(queries.some((q) => /title:\*harry\*.*OR.*title:\*potter\*/i.test(q))).toBe(true);
  });
});

describe("shopifyTruthSearch live", () => {
  beforeEach(() => {
    resetShopifyScopeCheck();
    vi.unstubAllGlobals();
    mockLiveShopifyFetch(mockCatalog);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("finds ISBN that exists in Shopify", async () => {
    const results = await truthSearchByIsbn("9783161484100");
    expect(results[0]?.title).toMatch(/Azkaban/i);
  });

  it("finds title that exists in Shopify", async () => {
    const results = await truthSearchByTitle("Harry Potter Azkaban");
    expect(results[0]?.title).toMatch(/Azkaban/i);
  });

  it("returns empty when product does not exist", async () => {
    const results = await truthSearchByTitle("Nonexistent Book Title XYZ");
    expect(results).toHaveLength(0);
  });
});
