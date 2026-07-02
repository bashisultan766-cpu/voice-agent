/**
 * Order lookup tool — returns data only; no user-facing speech.
 */
import { assertToolExecutionAllowed } from "../guards/toolExecutionGuard.js";
import { lookupOrder } from "../services/shopifyService.js";
import type { OrderLookupResult } from "../types/order.js";

export async function orderLookupTool(orderNumber: string): Promise<OrderLookupResult> {
  assertToolExecutionAllowed("orderLookupTool");
  return lookupOrder(orderNumber);
}
