import type { CallSession } from "../types/order.js";
import type { OrderView } from "./orderDisclosurePolicy.js";
import { aggregateOrderForCaller, type OrderAggregationDiagnostics } from "../adapters/orderAggregationEngine.js";
import { getSecureOrderVault } from "./callSecureVault.js";
import { armVerificationChallenge } from "./callerChallengeVerification.js";
import { parseCustomerLedgerNote } from "./ledgerNoteParser.js";
import { ensureSessionMemory } from "./sessionMemory.js";

/** Reads an order, applies caller verification, then returns the disclosure-safe DTO. */
export interface CallerOrderLookupResult {
  status: import("../adapters/shopifyStorefrontAdapter.js").OrderStatusResult["status"];
  orderView: OrderView | null;
  is_verified_caller: boolean;
  diagnostics?: OrderAggregationDiagnostics;
  message?: string;
  error?: string;
  searchedNumber?: string;
  verificationChallengePending?: boolean;
  parsedCustomerBalance?: import("./ledgerNoteParser.js").ParsedCustomerBalance | null;
}

/**
 * Enrich session intelligence after a found-order lookup:
 * challenge arming (unverified) + durable ledger parse from note/attributes.
 */
export function enrichOrderLookupIntelligence(session: CallSession): void {
  const memory = ensureSessionMemory(session);
  const vault = getSecureOrderVault(session.callSid);

  armVerificationChallenge(session);

  const ledger = parseCustomerLedgerNote(vault?.orderNote, vault?.customAttributes);
  if (ledger) {
    memory.parsedCustomerBalance = ledger;
  } else {
    memory.parsedCustomerBalance = undefined;
  }
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

  if (result.status === "found") {
    enrichOrderLookupIntelligence(session);
  }

  const memory = ensureSessionMemory(session);
  return {
    status: result.status,
    orderView: result.orderView,
    is_verified_caller: result.is_verified_caller,
    diagnostics: result.diagnostics,
    message: result.message,
    error: result.error,
    searchedNumber: result.searchedNumber,
    verificationChallengePending: memory.verificationChallengePending === true,
    parsedCustomerBalance: memory.parsedCustomerBalance ?? null,
  };
}

export const OrderLookupService = {
  lookupOrderForCaller,
  enrichOrderLookupIntelligence,
} as const;
