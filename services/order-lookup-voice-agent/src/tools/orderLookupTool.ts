/**
 * Order lookup tool — unified deep GraphQL path via lookupOrderStatus.
 * Legacy shallow/quick-search wrappers were removed; this is a thin alias only.
 */
import { assertToolAccessAuthorized } from "../guards/toolAccessGuard.js";
import { assertToolExecutionAllowed } from "../guards/toolExecutionGuard.js";
import { lookupOrder } from "../services/shopifyService.js";
import type { OrderLookupResult } from "../types/order.js";

export async function orderLookupTool(
  orderNumber: string,
  options?: { bypassCache?: boolean },
): Promise<OrderLookupResult> {
  assertToolAccessAuthorized("orderLookupTool", "orderLookupTool.ts");
  assertToolExecutionAllowed("orderLookupTool");
  return lookupOrder(orderNumber, options);
}

/** Spec alias — order ID → unified deep Shopify lookup. */
export const searchOrderById = orderLookupTool;
