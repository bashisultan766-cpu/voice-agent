import { describe, expect, it } from "vitest";
import { tokenFallbackSearch } from "../src/tools/productSemanticSearch.js";
import type { StructuredProduct } from "../src/types/product.js";

const catalog: StructuredProduct[] = [
  {
    id: "1",
    title: "Harry Potter and the Prisoner of Azkaban",
    handle: "hp3",
    productType: "Book",
    vendor: "Scholastic",
    tags: ["fantasy"],
    variants: [{ id: "v1", price: "10", inStock: true, inventoryQuantity: 1 }],
  },
];

describe("productSemanticSearch", () => {
  it("token fallback finds close match for vague query", () => {
    const results = tokenFallbackSearch("Harry Potter prison book", catalog, 3);
    expect(results[0]?.title).toMatch(/Azkaban/i);
  });
});
