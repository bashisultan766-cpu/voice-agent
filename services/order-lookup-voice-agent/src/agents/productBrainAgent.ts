/**
 * @deprecated Legacy parallel product path — NOT used in production voice flow.
 * All live calls use conversationOrchestrator only. Direct entry throws.
 */
import type { StructuredProduct } from "../types/product.js";

export interface ProductBrainInput {
  callSid: string;
  userMessage: string;
  intent?: "product_search" | "isbn_query";
}

export interface ProductBrainResult {
  speech: string;
  products: StructuredProduct[];
  usedSimilarFallback: boolean;
}

export async function handleProductBrainTurn(_input: ProductBrainInput): Promise<ProductBrainResult> {
  throw new Error(
    "DIRECT_TOOL_EXECUTION_FORBIDDEN: productBrainAgent is deprecated; use conversationOrchestrator.process",
  );
}
