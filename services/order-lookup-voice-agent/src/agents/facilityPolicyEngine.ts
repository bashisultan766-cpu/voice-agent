/**
 * FacilityPolicyEngine — business owner for facility eligibility / logistics
 * gating decisions. Thin wrapper over the existing logisticsIntelligence rules
 * so ShopifyQueryBoundary and cart / checkout owners route through ONE engine
 * instead of open-coding checks.
 */
import type { CallSession } from "../types/order.js";
import {
  checkLogisticsFeasibility,
  gateBatchForLogistics,
  verifyStockAvailability,
  type LogisticsFeasibilityResult,
  type VerifyStockAvailabilityResult,
} from "./logisticsIntelligence.js";
import type { CheckoutItemSelector } from "./cartManager.js";
import { ensureSessionMemory } from "./sessionMemory.js";

/** Immutable version tag so cart + checkout share the same policy snapshot. */
export const FACILITY_POLICY_VERSION = "facility-policy-2026-07-14";

export interface FacilityEligibilityDecision {
  decision: "allow" | "restrict";
  reason?: string;
  policyVersion: string;
  at: number;
}

/** Delegate to logisticsIntelligence but present as the domain owner. */
export function evaluateShipabilityForItem(
  input: {
    title?: string;
    variantId?: string;
    sku?: string;
    tags?: string[];
    metafields?: Array<{ namespace: string; key: string; value: string }>;
  },
  facilityType: string,
): LogisticsFeasibilityResult {
  return checkLogisticsFeasibility(input, facilityType);
}

export function gateCheckoutBatchForFacility(
  session: CallSession,
  selectors: CheckoutItemSelector[],
  facilityType?: string,
): ReturnType<typeof gateBatchForLogistics> {
  return gateBatchForLogistics(session, selectors, facilityType);
}

export function verifyStockForFacility(
  session: CallSession,
  selectors: CheckoutItemSelector[] | null | undefined,
  options?: Parameters<typeof verifyStockAvailability>[2],
): VerifyStockAvailabilityResult {
  return verifyStockAvailability(session, selectors ?? undefined, options);
}

/**
 * Persist the last eligibility decision in sessionMemory so cart-add and
 * checkout share the same version — never store raw logistics payloads.
 */
export function stampFacilityEligibility(
  session: CallSession,
  decision: FacilityEligibilityDecision["decision"],
  reason?: string,
): FacilityEligibilityDecision {
  const memory = ensureSessionMemory(session);
  const record: FacilityEligibilityDecision = {
    decision,
    reason,
    policyVersion: FACILITY_POLICY_VERSION,
    at: Date.now(),
  };
  memory.facilityEligibility = record;
  return record;
}

export function getFacilityEligibility(
  session: CallSession,
): FacilityEligibilityDecision | undefined {
  return ensureSessionMemory(session).facilityEligibility;
}

export const FacilityPolicyEngine = {
  evaluateShipabilityForItem,
  gateCheckoutBatchForFacility,
  verifyStockForFacility,
  stampFacilityEligibility,
  getFacilityEligibility,
  policyVersion: FACILITY_POLICY_VERSION,
} as const;
