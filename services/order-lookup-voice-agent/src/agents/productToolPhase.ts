/**
 * Phase 2 — Tool Execution Engine
 * Shopify product APIs run ONLY after Phase 1 slot filling confirms ISBN or title.
 */
import { logger } from "../utils/logger.js";
import {
  searchProductByCategory,
  searchProductByISBN,
  searchProductByTitle,
  STORE_NOT_FOUND_MESSAGE,
} from "../tools/shopifyProductTools.js";
import type { ProductSearchSlots } from "../types/order.js";
import type { StructuredProduct } from "../types/product.js";

export interface ProductSearchResult {
  speech: string;
  products: StructuredProduct[];
}

function formatProductHits(products: StructuredProduct[], usedAlternatives: boolean): string {
  if (products.length === 0) {
    return STORE_NOT_FOUND_MESSAGE;
  }
  const top = products.slice(0, 3);
  const lines = top.map((p) => {
    const price = p.variants[0]?.price ?? "N/A";
    const stock = p.variants.some((v) => v.inStock) ? "in stock" : "out of stock";
    return `"${p.title}" at ${price} dollars, ${stock}`;
  });
  if (usedAlternatives) {
    return `I couldn't find that exact match, but here are close options: ${lines.join("; ")}.`;
  }
  return `Yes — I found ${lines.join("; ")}.`;
}

/** Execute Shopify product search — Phase 2 only. */
export async function executeProductSearch(
  slots: ProductSearchSlots,
  callSid: string,
): Promise<ProductSearchResult> {
  const started = Date.now();

  if (slots.isbn) {
    const result = await searchProductByISBN(slots.isbn);
    if (result.products.length > 0) {
      logger.info("product_tool_isbn_hit", {
        callSid: callSid.slice(0, 8),
        isbn: slots.isbn,
        count: result.products.length,
        elapsedMs: Date.now() - started,
      });
      return {
        speech: formatProductHits(result.products, false),
        products: result.products,
      };
    }
    const alt = await searchProductByCategory("books inmates");
    logger.info("product_tool_isbn_fallback", {
      callSid: callSid.slice(0, 8),
      isbn: slots.isbn,
      altCount: alt.products.length,
      elapsedMs: Date.now() - started,
    });
    return {
      speech: formatProductHits(alt.products, alt.products.length > 0),
      products: alt.products,
    };
  }

  if (slots.title) {
    const result = await searchProductByTitle(slots.title);
    if (result.products.length > 0) {
      logger.info("product_tool_title_hit", {
        callSid: callSid.slice(0, 8),
        title: slots.title,
        count: result.products.length,
        elapsedMs: Date.now() - started,
      });
      return {
        speech: formatProductHits(result.products, false),
        products: result.products,
      };
    }
    const alt = await searchProductByCategory(`${slots.title} books`);
    const broad =
      alt.products.length > 0 ? alt : await searchProductByCategory("books inmates");
    logger.info("product_tool_title_fallback", {
      callSid: callSid.slice(0, 8),
      title: slots.title,
      altCount: broad.products.length,
      elapsedMs: Date.now() - started,
    });
    return {
      speech: formatProductHits(broad.products, broad.products.length > 0),
      products: broad.products,
    };
  }

  return { speech: STORE_NOT_FOUND_MESSAGE, products: [] };
}
