import { logger } from "../utils/logger.js";
import { lookupOrder } from "./shopifyService.js";
import { preAnalyzeOrderIntent } from "./llmService.js";
import {
  planInstantConfirmation,
  planLookupError,
  planOrderLookupResponse,
} from "../agents/responsePlanner.js";
import type { OrderLookupResult, SpeechChunk, SpeechPlan, StructuredOrder } from "../types/order.js";

export interface PrefetchResult {
  lookup: OrderLookupResult;
  plan: SpeechPlan | null;
  order: StructuredOrder | null;
  lookupMs: number;
}

/**
 * Parallel prefetch: Shopify lookup + background LLM intent note (non-blocking).
 * Speech plan is built synchronously once order data arrives.
 */
export async function prefetchOrderResponse(orderNumber: string): Promise<PrefetchResult> {
  const started = Date.now();

  const [lookup] = await Promise.all([
    lookupOrder(orderNumber),
    preAnalyzeOrderIntent(orderNumber).catch(() => undefined),
  ]);

  const lookupMs = Date.now() - started;

  if (lookup.status === "found") {
    const detailPlan = planOrderLookupResponse(lookup.order);
    const plan: SpeechPlan = {
      tone: detailPlan.tone,
      chunks: [planInstantConfirmation(lookup.order), ...detailPlan.chunks],
    };

    logger.debug("prefetch_complete", {
      orderNumber,
      lookupMs,
      chunkCount: plan.chunks.length,
      refunded: lookup.order.refund.refunded,
    });

    return {
      lookup,
      plan,
      order: lookup.order,
      lookupMs,
    };
  }

  return {
    lookup,
    plan: planLookupError(lookup),
    order: null,
    lookupMs,
  };
}

export async function* streamPrefetchedChunks(
  orderNumber: string,
  instantFiller: SpeechChunk,
): AsyncGenerator<SpeechChunk, PrefetchResult> {
  yield instantFiller;

  const result = await prefetchOrderResponse(orderNumber);
  if (!result.plan) return result;

  for (const chunk of result.plan.chunks) {
    yield chunk;
  }

  return result;
}
