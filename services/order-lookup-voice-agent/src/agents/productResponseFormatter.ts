/**

 * Response Engineer — formats grounded voice output only (no hallucination).

 */

import { EXACT_MATCH_NOT_FOUND_MESSAGE } from "../constants/systemMessages.js";

import type { CanonicalProduct } from "./productRetrievalPolicy.js";

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

  mode: "search" | "recommendations" | "ambiguous" = "search",

): string {

  if (products.length === 0) {

    return EXACT_MATCH_NOT_FOUND_MESSAGE;

  }



  if (mode === "recommendations") {

    const picks = products.slice(0, 3).map(formatOneProduct);

    return `Here are a few popular picks from the catalog: ${picks.join(". ")}.`;

  }



  if (mode === "ambiguous") {

    const picks = products.slice(0, 3).map((p, index) => `Option ${index + 1}: ${formatOneProduct(p)}`);

    return `${EXACT_MATCH_NOT_FOUND_MESSAGE} Here are multiple valid options: ${picks.join(". ")}.`;

  }



  if (usedAlternatives) {

    const picks = products.slice(0, 3).map(formatOneProduct);

    if (picks.length === 0) {

      return EXACT_MATCH_NOT_FOUND_MESSAGE;

    }

    const countLabel =

      picks.length === 1 ? "one option" : picks.length === 2 ? "two options" : "three options";

    return `${EXACT_MATCH_NOT_FOUND_MESSAGE} Here are the closest valid alternatives — ${countLabel}: ${picks.join(". ")}.`;

  }



  const top = products[0];

  const price = formatVoicePrice(top.variants[0]?.price ?? "0");

  const inStock = top.variants.some((v) => v.inStock);

  return `Yes — we have "${top.title}" for ${price}, and it is ${formatStockPhrase(inStock)}.`;

}



/** Fail-safe when canonical validation cannot confirm a single product. */

export function formatValidationFailureCandidates(candidates: CanonicalProduct[]): string {

  if (candidates.length === 0) {

    return EXACT_MATCH_NOT_FOUND_MESSAGE;

  }



  const picks = candidates.slice(0, 2).map((candidate, index) => {

    const price = formatVoicePrice(candidate.raw.variants[0]?.price ?? "0");

    const inStock = candidate.raw.variants.some((v) => v.inStock);

    return `Option ${index + 1}: "${candidate.raw.title}" for ${price}, ${formatStockPhrase(inStock)}`;

  });



  return `${EXACT_MATCH_NOT_FOUND_MESSAGE} Here are the closest valid alternatives: ${picks.join(". ")}. Please share the full title or ISBN to confirm.`;

}


