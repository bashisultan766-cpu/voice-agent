import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isbnLookupVariants,
  normalizeIsbn,
  normalizeSearchText,
  rankBySearchScore,
  scoreTitleMatch,
} from "../src/utils/productSearchNormalize.js";
import { tokenFallbackSearch } from "../src/tools/productSemanticSearch.js";
import {
  clearProductCache,
  getSimilarProducts,
  searchProductByISBN,
  searchProductByTitle,
} from "../src/tools/shopifyProductTools.js";
import { clearCatalogCache } from "../src/tools/productCatalog.js";
import type { StructuredProduct } from "../src/types/product.js";

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
    variants: [{ id: "10", sku: "9783161484100", barcode: "9783161484100", price: "14.99", inStock: true, inventoryQuantity: 4 }],
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

function mockCatalogFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: mockCatalog.map((p) => ({
              node: {
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
              },
            })),
          },
        },
      }),
    })),
  );
}

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

  it("handles misspelled input via token fallback", () => {
    const results = tokenFallbackSearch("Hary Poter Azkaban", mockCatalog, 3);
    expect(results[0]?.title).toMatch(/Azkaban/i);
  });

  it("normalizes punctuation in search text", () => {
    expect(normalizeSearchText("Harry-Potter!!!")).toBe("harry potter");
    expect(scoreTitleMatch("Harry Potter and the Prisoner of Azkaban", "harry potter azkaban")).toBeGreaterThanOrEqual(2);
  });
});

describe("shopifyProductTools search engine", () => {
  beforeEach(() => {
    clearProductCache();
    clearCatalogCache();
    vi.unstubAllGlobals();
    mockCatalogFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("finds product by ISBN 9783161484100", async () => {
    const result = await searchProductByISBN("9783161484100");
    expect(result.status).toBe("found");
    expect(result.products[0]?.title).toMatch(/Azkaban/i);
  });

  it("finds same product for hyphenated ISBN", async () => {
    const a = await searchProductByISBN("9783161484100");
    clearProductCache();
    clearCatalogCache();
    mockCatalogFetch();
    const b = await searchProductByISBN("978-3-16-148410-0");
    expect(a.products[0]?.id).toBe(b.products[0]?.id);
  });

  it('finds "Harry Potter Azkaban" by title', async () => {
    const result = await searchProductByTitle("Harry Potter Azkaban");
    expect(result.products[0]?.title).toMatch(/Azkaban/i);
  });

  it("returns similar books when searching related title", async () => {
    const result = await getSimilarProducts("1");
    expect(result.products.length).toBeGreaterThanOrEqual(1);
    expect(result.products.some((p) => p.id !== "1")).toBe(true);
  });
});
