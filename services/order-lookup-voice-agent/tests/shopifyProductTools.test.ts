import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isbnLookupVariants,
  normalizeIsbn,
  normalizeSearchText,
  rankBySearchScore,
  rankLiveProducts,
  scoreTitleMatch,
} from "../src/utils/productSearchNormalize.js";
import {
  clearProductCache,
  getSimilarProducts,
  searchProductByISBN,
  searchProductByTitle,
  STORE_NOT_FOUND_MESSAGE,
} from "../src/tools/shopifyProductTools.js";
import type { StructuredProduct } from "../src/types/product.js";
import { mockLiveShopifyFetch, mockShopifyMissingProductScope } from "./helpers/mockLiveShopify.js";
import { resetShopifyScopeCheck } from "../src/tools/shopifyScopeCheck.js";
import { enableToolExecutionForTests, resetToolExecutionGuard } from "../src/guards/toolExecutionGuard.js";
import { enableToolAccessForTests, resetToolAccessGuard } from "../src/guards/toolAccessGuard.js";

const mockCatalog: StructuredProduct[] = [
  {
    id: "1",
    title: "Harry Potter and the Prisoner of Azkaban",
    handle: "hp-azkaban",
    productType: "Book",
    vendor: "J.K. Rowling",
    author: "J.K. Rowling",
    tags: ["fiction", "fantasy", "inmate"],
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
  {
    id: "2",
    title: "Harry Potter and the Sorcerer's Stone",
    handle: "hp-1",
    productType: "Book",
    vendor: "J.K. Rowling",
    tags: ["fiction", "fantasy"],
    variants: [{ id: "11", sku: "HP1", price: "12.99", inStock: true, inventoryQuantity: 5 }],
  },
  {
    id: "3",
    title: "Inmate Magazine Monthly",
    handle: "mag-monthly",
    productType: "Magazine",
    vendor: "SureShot",
    tags: ["magazine", "inmates"],
    variants: [{ id: "12", price: "5.99", inStock: true, inventoryQuantity: 20 }],
  },
  {
    id: "4",
    title: "Daily Newspaper Digest",
    handle: "news-digest",
    productType: "Newspaper",
    vendor: "SureShot",
    tags: ["newspaper", "inmates"],
    variants: [{ id: "13", price: "3.99", inStock: true, inventoryQuantity: 15 }],
  },
];

describe("productSearchNormalize", () => {
  it("normalizes ISBN hyphen formats to same value", () => {
    expect(normalizeIsbn("978-3-16-148410-0")).toBe("9783161484100");
    expect(isbnLookupVariants("978-3-16-148410-0")).toContain("9783161484100");
  });

  it("scores Harry Potter Azkaban highly", () => {
    const ranked = rankBySearchScore(mockCatalog, "Harry Potter Azkaban");
    expect(ranked[0]?.title).toMatch(/Azkaban/i);
    expect(ranked[0]?.searchScore).toBeGreaterThanOrEqual(2);
  });

  it("ranks live products with exact title match highest", () => {
    const ranked = rankLiveProducts(mockCatalog, "Harry Potter and the Prisoner of Azkaban");
    expect(ranked[0]?.title).toMatch(/Azkaban/i);
  });

  it("normalizes punctuation in search text", () => {
    expect(normalizeSearchText("Harry-Potter!!!")).toBe("harry potter");
    expect(scoreTitleMatch("Harry Potter and the Prisoner of Azkaban", "harry potter azkaban")).toBeGreaterThanOrEqual(2);
  });
});

describe("shopifyProductTools live search", () => {
  beforeEach(() => {
    clearProductCache();
    resetShopifyScopeCheck();
    resetToolExecutionGuard();
    resetToolAccessGuard();
    enableToolExecutionForTests(true);
    enableToolAccessForTests(true);
    vi.unstubAllGlobals();
    mockLiveShopifyFetch(mockCatalog);
  });

  afterEach(() => {
    enableToolExecutionForTests(false);
    enableToolAccessForTests(false);
    resetToolExecutionGuard();
    resetToolAccessGuard();
    vi.unstubAllGlobals();
  });

  it("finds product by ISBN 9783161484100 quickly", async () => {
    const started = Date.now();
    const result = await searchProductByISBN("9783161484100");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.status).toBe("found");
    expect(result.products[0]?.title).toMatch(/Azkaban/i);
  });

  it("finds same product for hyphenated ISBN", async () => {
    const a = await searchProductByISBN("9783161484100");
    const b = await searchProductByISBN("978-3-16-148410-0");
    expect(a.products[0]?.id).toBe(b.products[0]?.id);
  });

  it('finds exact "Harry Potter Azkaban" by title', async () => {
    const result = await searchProductByTitle("Harry Potter Azkaban");
    expect(result.products[0]?.title).toMatch(/Azkaban/i);
  });

  it("handles misspelled title via live query expansion", async () => {
    const result = await searchProductByTitle("Hary Poter Azkaban");
    expect(result.products[0]?.title).toMatch(/Azkaban/i);
  });

  it("returns ranked partial title matches", async () => {
    const result = await searchProductByTitle("Harry Potter");
    expect(result.products.length).toBeGreaterThanOrEqual(2);
    expect(result.products.every((p) => /Harry Potter/i.test(p.title))).toBe(true);
  });

  it("returns store-not-found message when Shopify has no match", async () => {
    const result = await searchProductByTitle("Nonexistent Book Title XYZ");
    expect(result.status).toBe("not_found");
    expect(result.products).toHaveLength(0);
    expect(result.message).toBe(STORE_NOT_FOUND_MESSAGE);
  });

  it("returns similar books from live data", async () => {
    const result = await getSimilarProducts("1");
    expect(result.products.length).toBeGreaterThanOrEqual(1);
    expect(result.products.some((p) => p.id !== "1")).toBe(true);
  });

  it("returns api_error when Shopify token is missing read_products scope", async () => {
    clearProductCache();
    resetShopifyScopeCheck();
    vi.unstubAllGlobals();
    mockShopifyMissingProductScope();

    const result = await searchProductByISBN("9783161484100");
    expect(result.status).toBe("api_error");
    expect(result.products).toHaveLength(0);
  });
});
