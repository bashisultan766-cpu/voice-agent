/**
 * Turns product tool data into natural voice responses (brain layer only).
 */
import { STORE_NOT_FOUND_MESSAGE } from "../tools/shopifyProductTools.js";
import type { StructuredProduct } from "../types/product.js";

function formatOneProduct(p: StructuredProduct): string {
  const price = p.variants[0]?.price ?? "N/A";
  const stock = p.variants.some((v) => v.inStock) ? "in stock" : "out of stock";
  return `"${p.title}" at ${price} dollars, ${stock}`;
}

export function formatProductResults(
  products: StructuredProduct[],
  usedAlternatives: boolean,
  mode: "search" | "recommendations" = "search",
): string {
  if (products.length === 0) {
    return STORE_NOT_FOUND_MESSAGE;
  }

  if (mode === "recommendations") {
    const picks = products.slice(0, 3).map(formatOneProduct);
    return `Here are a few popular picks: ${picks.join(". ")}.`;
  }

  if (usedAlternatives) {
    const picks = products.slice(0, 3).map(formatOneProduct);
    if (picks.length === 0) {
      return STORE_NOT_FOUND_MESSAGE;
    }
    const countLabel =
      picks.length === 1 ? "one option" : picks.length === 2 ? "two options" : "three options";
    return `I don't have that exact book, but here are ${countLabel}: ${picks.join(". ")}.`;
  }

  const top = products[0];
  const price = top.variants[0]?.price ?? "N/A";
  const stock = top.variants.some((v) => v.inStock) ? "in stock" : "out of stock";
  return `Yes — "${top.title}" is ${price} dollars and ${stock}.`;
}
