import { describe, expect, it } from "vitest";
import { formatProductResults } from "../src/agents/productResponseFormatter.js";
import type { StructuredProduct } from "../src/types/product.js";

const sample: StructuredProduct = {
  id: "1",
  title: "Harry Potter and the Prisoner of Azkaban",
  handle: "hp",
  productType: "Book",
  vendor: "Rowling",
  tags: ["fiction"],
  variants: [{ id: "10", price: "14.99", inStock: true, inventoryQuantity: 3 }],
};

describe("formatProductResults", () => {
  it("formats exact match with voice-friendly price and stock", () => {
    const speech = formatProductResults([sample], false);
    expect(speech).toMatch(/Harry Potter/);
    expect(speech).toMatch(/14 dollars and 99 cents/i);
    expect(speech).toMatch(/in stock and available/i);
    expect(speech).not.toMatch(/similar options/i);
  });

  it("announces not found then similar products", () => {
    const similar = [
      sample,
      { ...sample, id: "2", title: "Inmate Reading Guide" },
    ];
    const speech = formatProductResults(similar, true);
    expect(speech).toMatch(/don't have that exact book/i);
    expect(speech).toMatch(/options/i);
  });

  it("never returns empty when products exist", () => {
    expect(formatProductResults([sample], false).length).toBeGreaterThan(10);
  });
});
