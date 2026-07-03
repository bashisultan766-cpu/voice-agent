import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeProductSearch } from "../src/agents/productToolPhase.js";
import { enableToolAccessForTests, resetToolAccessGuard } from "../src/guards/toolAccessGuard.js";
import { enableToolExecutionForTests, resetToolExecutionGuard } from "../src/guards/toolExecutionGuard.js";
import * as shopifyProductTools from "../src/tools/shopifyProductTools.js";
import type { StructuredProduct } from "../src/types/product.js";

const weakMatch: StructuredProduct = {
  id: "99",
  title: "Unrelated Cooking Guide",
  handle: "cook",
  productType: "Book",
  vendor: "Other",
  tags: ["cooking"],
  variants: [{ id: "1", price: "9.99", inStock: true, inventoryQuantity: 2 }],
};

const similar: StructuredProduct = {
  id: "2",
  title: "Inmate Reading Guide",
  handle: "guide",
  productType: "Book",
  vendor: "SureShot",
  tags: ["books"],
  variants: [{ id: "3", price: "12.99", inStock: true, inventoryQuantity: 5 }],
};

describe("productToolPhase", () => {
  beforeEach(() => {
    resetToolExecutionGuard();
    resetToolAccessGuard();
    enableToolExecutionForTests(true);
    enableToolAccessForTests(true);
    vi.restoreAllMocks();
  });

  it("treats weak title matches as miss and returns similar alternatives", async () => {
    vi.spyOn(shopifyProductTools, "searchProductByTitle").mockResolvedValue({
      status: "found",
      products: [weakMatch],
      query: "Imaginary Title XYZ",
    });
    vi.spyOn(shopifyProductTools, "getSimilarProducts").mockResolvedValue({
      status: "found",
      products: [similar, { ...similar, id: "3", title: "Popular Picks" }],
      query: "similar:99",
    });

    const result = await executeProductSearch(
      { title: "Imaginary Title XYZ" },
      "CA_TOOL",
    );

    expect(result.usedAlternatives).toBe(true);
    expect(result.products.length).toBeLessThanOrEqual(3);
    expect(result.products[0]?.title).toMatch(/Inmate|Popular/i);
  });
});
