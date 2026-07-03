/**
 * Order lookup tool — returns data only; no user-facing speech.
 */
import { assertToolAccessAuthorized } from "../guards/toolAccessGuard.js";
import { assertToolExecutionAllowed } from "../guards/toolExecutionGuard.js";
import { lookupOrder } from "../services/shopifyService.js";
import type { OrderLookupResult } from "../types/order.js";

export async function orderLookupTool(orderNumber: string): Promise<OrderLookupResult> {
  assertToolAccessAuthorized("orderLookupTool");
  assertToolExecutionAllowed("orderLookupTool");
  return lookupOrder(orderNumber);
}
