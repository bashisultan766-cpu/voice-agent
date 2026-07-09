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

  it("formats ambiguous title matches as multiple options", () => {
    const speech = formatProductResults(
      [
        sample,
        { ...sample, id: "2", title: "Harry Potter and the Chamber of Secrets" },
      ],
      false,
      "ambiguous",
    );
    expect(speech).toMatch(/multiple valid options|could not find an exact match/i);
    expect(speech).toMatch(/Option 1/i);
    expect(speech).toMatch(/Option 2/i);
  });

  it("announces not found then similar products", () => {
    const similar = [
      sample,
      { ...sample, id: "2", title: "Inmate Reading Guide" },
    ];
    const speech = formatProductResults(similar, true);
    expect(speech).toMatch(/couldn't find the exact title/i);
    expect(speech).toMatch(/similar matches/i);
  });

  it("never returns empty when products exist", () => {
    expect(formatProductResults([sample], false).length).toBeGreaterThan(10);
  });
});
