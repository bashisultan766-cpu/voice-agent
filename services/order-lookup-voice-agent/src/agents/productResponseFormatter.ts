/**
 * Turns product tool data into natural voice responses (brain layer only).
 */
import { STORE_NOT_FOUND_MESSAGE } from "../tools/shopifyProductTools.js";
import type { StructuredProduct } from "../types/product.js";

export function formatProductResults(
  products: StructuredProduct[],
  usedAlternatives: boolean,
  mode: "search" | "recommendations" = "search",
): string {
  if (products.length === 0) {
    return STORE_NOT_FOUND_MESSAGE;
  }
  const top = products.slice(0, 3);
  const lines = top.map((p) => {
    const price = p.variants[0]?.price ?? "N/A";
    const stock = p.variants.some((v) => v.inStock) ? "in stock" : "out of stock";
    return `"${p.title}" at ${price} dollars, ${stock}`;
  });
  if (mode === "recommendations") {
    return `Here are a few popular picks: ${lines.join("; ")}.`;
  }
  if (usedAlternatives) {
    return `I couldn't find that exact match, but here are close options: ${lines.join("; ")}.`;
  }
  return `Yes — I found ${lines.join("; ")}.`;
}
