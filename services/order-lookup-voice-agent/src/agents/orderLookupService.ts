import type { CallSession } from "../types/order.js";
import { buildOrderView, type OrderView } from "./orderDisclosurePolicy.js";
import { aggregateOrderForCaller, type OrderAggregationDiagnostics } from "../adapters/orderAggregationEngine.js";

/** Reads an order, applies caller verification, then returns the disclosure-safe DTO. */
export interface CallerOrderLookupResult {
  status: import("../adapters/shopifyStorefrontAdapter.js").OrderStatusResult["status"];
  orderView: OrderView | null;
  is_verified_caller: boolean;
  diagnostics?: OrderAggregationDiagnostics;
  message?: string;
  error?: string;
  searchedNumber?: string;
}

export async function lookupOrderForCaller(
  session: CallSession,
  orderNumber: string,
): Promise<CallerOrderLookupResult> {
  const result = await aggregateOrderForCaller(
    orderNumber,
    session.callerPhone ?? session.from ?? "",
    session.callSid,
  );
  session.isVerifiedCaller = result.is_verified_caller;
  return {
    status: result.status,
    orderView: result.orderView,
    is_verified_caller: result.is_verified_caller,
    diagnostics: result.diagnostics,
    message: result.message,
    error: result.error,
    searchedNumber: result.searchedNumber,
  };
}

export const OrderLookupService = { lookupOrderForCaller } as const;
