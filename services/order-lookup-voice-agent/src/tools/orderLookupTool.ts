/**
 * Order lookup tool — returns data only; no user-facing speech.
 */
import { lookupOrder } from "../services/shopifyService.js";
import type { OrderLookupResult } from "../types/order.js";

export async function orderLookupTool(orderNumber: string): Promise<OrderLookupResult> {
  return lookupOrder(orderNumber);
}
