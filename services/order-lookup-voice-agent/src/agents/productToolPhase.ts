/**
 * Phase 2 — Tool Execution Engine (data only, no user-facing speech).
 * MUST only be invoked from conversationOrchestrator inside runInPhase2.
 */
import { logger } from "../utils/logger.js";
import { assertToolExecutionAllowed } from "../guards/toolExecutionGuard.js";
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
  assertToolExecutionAllowed("executeProductSearch");
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
    const fallback = await fetchSimilarFallback(callSid, slots.title, lastProductId);
    logger.info("product_tool_isbn_fallback", {
      callSid: callSid.slice(0, 8),
      isbn: slots.isbn,
      altCount: fallback.products.length,
      elapsedMs: Date.now() - started,
    });
    return { ...fallback, searchKind: "isbn" };
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
    const fallback = await fetchSimilarFallback(callSid, slots.title, lastProductId);
    logger.info("product_tool_title_fallback", {
      callSid: callSid.slice(0, 8),
      title: slots.title,
      altCount: fallback.products.length,
      elapsedMs: Date.now() - started,
    });
    return { ...fallback, searchKind: "title" };
  }

  return { products: [], usedAlternatives: false, searchKind: "recommendations" };
}

async function fetchSimilarFallback(
  callSid: string,
  anchorTitle?: string,
  lastProductId?: string,
): Promise<Omit<ToolProductResult, "searchKind">> {
  if (lastProductId) {
    const similar = await getSimilarProducts(lastProductId);
    if (similar.products.length > 0) {
      return {
        products: similar.products.slice(0, 3),
        usedAlternatives: true,
      };
    }
  }

  if (anchorTitle) {
    const loose = await searchProductByTitle(anchorTitle.split(" ")[0] ?? anchorTitle);
    if (loose.products[0]) {
      const similar = await getSimilarProducts(loose.products[0].id);
      if (similar.products.length > 0) {
        return {
          products: similar.products.slice(0, 3),
          usedAlternatives: true,
        };
      }
    }
  }

  const browse = await searchProductByCategory("books inmates");
  if (browse.products[0]) {
    const similar = await getSimilarProducts(browse.products[0].id);
    if (similar.products.length > 0) {
      return {
        products: similar.products.slice(0, 3),
        usedAlternatives: true,
      };
    }
    return {
      products: browse.products.slice(0, 3),
      usedAlternatives: true,
    };
  }

  return { products: [], usedAlternatives: false };
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
        products: similar.products.slice(0, 3),
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
    products: popular.products.slice(0, 3),
    usedAlternatives: false,
    searchKind: "recommendations",
  };
}
