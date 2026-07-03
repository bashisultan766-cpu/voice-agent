/**
 * Turns product tool data into natural voice responses (brain layer only).
 */
import { STORE_NOT_FOUND_MESSAGE } from "../tools/shopifyProductTools.js";
import type { StructuredProduct } from "../types/product.js";

function formatVoicePrice(price: string): string {
  const value = Number(price);
  if (!Number.isFinite(value)) return price;

  const dollars = Math.floor(value);
  const cents = Math.round((value - dollars) * 100);

  if (cents === 0) {
    return `${dollars} dollar${dollars === 1 ? "" : "s"}`;
  }

  return `${dollars} dollar${dollars === 1 ? "" : "s"} and ${cents} cent${cents === 1 ? "" : "s"}`;
}

function formatStockPhrase(inStock: boolean): string {
  return inStock ? "in stock and available" : "not in stock right now";
}

function formatOneProduct(p: StructuredProduct): string {
  const price = formatVoicePrice(p.variants[0]?.price ?? "0");
  const inStock = p.variants.some((v) => v.inStock);
  return `"${p.title}" for ${price}, ${formatStockPhrase(inStock)}`;
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
  const price = formatVoicePrice(top.variants[0]?.price ?? "0");
  const inStock = top.variants.some((v) => v.inStock);
  return `Yes — we have "${top.title}" for ${price}, and it is ${formatStockPhrase(inStock)}.`;
}
