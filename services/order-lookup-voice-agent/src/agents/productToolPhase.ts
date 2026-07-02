/**
 * Phase 2 — Tool Execution Engine (data only, no user-facing speech).
 */
import { logger } from "../utils/logger.js";
import {
  getSimilarProducts,
  searchProductByCategory,
  searchProductByISBN,
  searchProductByTitle,
} from "../tools/shopifyProductTools.js";
import type { ProductSearchSlots } from "../types/order.js";
import type { StructuredProduct } from "../types/product.js";

export interface ToolProductResult {
  products: StructuredProduct[];
  usedAlternatives: boolean;
  searchKind: "isbn" | "title" | "recommendations";
}

/** Execute Shopify product search — Phase 2 only. */
export async function executeProductSearch(
  slots: ProductSearchSlots,
  callSid: string,
  lastProductId?: string,
): Promise<ToolProductResult> {
  const started = Date.now();

  if (slots.wantsRecommendations) {
    return executeRecommendations(callSid, started, lastProductId);
  }

  if (slots.isbn) {
    const result = await searchProductByISBN(slots.isbn);
    if (result.products.length > 0) {
      logger.info("product_tool_isbn_hit", {
        callSid: callSid.slice(0, 8),
        isbn: slots.isbn,
        count: result.products.length,
        elapsedMs: Date.now() - started,
      });
      return { products: result.products, usedAlternatives: false, searchKind: "isbn" };
    }
    const alt = await searchProductByCategory("books inmates");
    logger.info("product_tool_isbn_fallback", {
      callSid: callSid.slice(0, 8),
      isbn: slots.isbn,
      altCount: alt.products.length,
      elapsedMs: Date.now() - started,
    });
    return {
      products: alt.products,
      usedAlternatives: alt.products.length > 0,
      searchKind: "isbn",
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
      return { products: result.products, usedAlternatives: false, searchKind: "title" };
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
      products: broad.products,
      usedAlternatives: broad.products.length > 0,
      searchKind: "title",
    };
  }

  return { products: [], usedAlternatives: false, searchKind: "recommendations" };
}

async function executeRecommendations(
  callSid: string,
  started: number,
  lastProductId?: string,
): Promise<ToolProductResult> {
  if (lastProductId) {
    const similar = await getSimilarProducts(lastProductId);
    if (similar.products.length > 0) {
      logger.info("product_tool_similar_hit", {
        callSid: callSid.slice(0, 8),
        productId: lastProductId,
        count: similar.products.length,
        elapsedMs: Date.now() - started,
      });
      return {
        products: similar.products,
        usedAlternatives: false,
        searchKind: "recommendations",
      };
    }
  }

  const popular = await searchProductByCategory("books inmates");
  logger.info("product_tool_recommendations", {
    callSid: callSid.slice(0, 8),
    count: popular.products.length,
    elapsedMs: Date.now() - started,
  });
  return {
    products: popular.products,
    usedAlternatives: false,
    searchKind: "recommendations",
  };
}
