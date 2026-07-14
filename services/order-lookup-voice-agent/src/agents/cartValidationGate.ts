/**
 * CartValidationGate — atomic pre-payment gate (v2026).
 * Payment / DraftOrder / send_checkout_link MUST NOT run until this passes.
 * One task at a time: validate partition → then draft → then send.
 */
import type { CallSession } from "../types/order.js";
import {
  getCartSummary,
  resolveCheckoutLineItems,
  validateCartForCheckout,
  type CheckoutItemSelector,
} from "./cartManager.js";
import {
  gateBatchForLogistics,
  verifyStockAvailability,
  type LiveInventoryMap,
} from "./logisticsIntelligence.js";
import { isCheckoutPassiveReadOnly } from "./flowMutex.js";
import { hasUnacknowledgedFailure } from "./failureState.js";

export type CartValidationFailureCode =
  | "EMPTY_CART"
  | "INVALID_LINE"
  | "LOGISTICS_BLOCKED"
  | "INVENTORY_BLOCKED"
  | "PARTITION_UNRESOLVED"
  | "EMAIL_UNCONFIRMED"
  | "CHECKOUT_PASSIVE"
  | "UNACKNOWLEDGED_FAILURE";

export interface CartValidationGateResult {
  ok: boolean;
  /** FAILURE_STATE code when blocked — agent must acknowledge before retry. */
  failureState?: CartValidationFailureCode;
  message: string;
  /** Validated selectors ready for DraftOrder (ISBN/title/qty resolved). */
  selectors?: CheckoutItemSelector[];
  logisticsSpeech?: string;
  stockSpeech?: string;
}

export interface CartValidationGateOptions {
  selectors?: CheckoutItemSelector[] | null;
  liveInventory?: LiveInventoryMap;
  inventoryUnavailable?: boolean;
  facilityType?: string;
  /** Require letter-by-letter confirmed email before payment (default true for send). */
  requireConfirmedEmail?: boolean;
  /** Skip unacknowledged prior FAILURE_STATE check (internal retry after ack). */
  skipFailureAckCheck?: boolean;
}

function partitionSelectors(
  session: CallSession,
  selectors?: CheckoutItemSelector[] | null,
): CheckoutItemSelector[] {
  if (selectors?.length) return selectors;
  return getCartSummary(session).items.map((line) => ({
    variant_id: line.variantId,
    title: line.title,
    quantity: line.quantity,
  }));
}

/**
 * Atomic CartValidationGate — must pass before any payment / DraftOrder logic.
 * Verifies ISBN/title partition lines, logistics, and stock for the requested batch.
 */
export function runCartValidationGate(
  session: CallSession,
  options?: CartValidationGateOptions,
): CartValidationGateResult {
  if (!options?.skipFailureAckCheck) {
    if (hasUnacknowledgedFailure(session)) {
      const pending = session.sessionMemory?.lastFailureState;
      return {
        ok: false,
        failureState: "UNACKNOWLEDGED_FAILURE",
        message:
          pending?.message ||
          "The previous step failed. Please acknowledge that issue before we retry checkout.",
      };
    }
  }

  if (isCheckoutPassiveReadOnly(session)) {
    return {
      ok: false,
      failureState: "CHECKOUT_PASSIVE",
      message:
        "I've paused checkout while we connect you with a human agent. No payment link will be sent until that handoff is complete.",
    };
  }

  if (options?.requireConfirmedEmail !== false) {
    const conf = session.emailConfirmation;
    const confirmed =
      conf?.confirmationStatus === "confirmed" && Boolean(conf.confirmedEmail?.trim());
    if (!confirmed) {
      return {
        ok: false,
        failureState: "EMAIL_UNCONFIRMED",
        message:
          "Email must be verified letter-by-letter and explicitly confirmed before sending a payment link.",
      };
    }
  }

  const selectorInput = partitionSelectors(session, options?.selectors);
  if (!selectorInput.length) {
    return {
      ok: false,
      failureState: "EMPTY_CART",
      message: "Cart is empty — add books before checkout.",
    };
  }

  const logistics = gateBatchForLogistics(
    session,
    selectorInput,
    options?.facilityType ?? session.facilityType,
  );
  if (!logistics.ok) {
    return {
      ok: false,
      failureState: "LOGISTICS_BLOCKED",
      message:
        logistics.speech ??
        "None of the selected books meet the facility's packaging requirements.",
      logisticsSpeech: logistics.speech,
    };
  }

  const stock = verifyStockAvailability(session, logistics.selectors, {
    liveInventory: options?.liveInventory,
    inventoryUnavailable: options?.inventoryUnavailable,
  });
  if (!stock.ok) {
    return {
      ok: false,
      failureState: "INVENTORY_BLOCKED",
      message:
        stock.speech ??
        "Inventory changed before checkout. Your cart has been updated — no payment link was sent.",
      stockSpeech: stock.speech,
    };
  }

  const resolved = resolveCheckoutLineItems(session, stock.viableSelectors);
  if (!resolved.ok) {
    return {
      ok: false,
      failureState: "PARTITION_UNRESOLVED",
      message: resolved.message,
    };
  }

  if (!resolved.items.length) {
    return {
      ok: false,
      failureState: "EMPTY_CART",
      message: "Cart is empty — add books before checkout.",
    };
  }

  const cartValidationError = validateCartForCheckout(resolved.items);
  if (cartValidationError) {
    return {
      ok: false,
      failureState: "INVALID_LINE",
      message: cartValidationError,
    };
  }

  return {
    ok: true,
    message: "CartValidationGate passed.",
    selectors: stock.viableSelectors,
    logisticsSpeech: logistics.speech,
    stockSpeech: stock.speech,
  };
}

export const CartValidationGate = {
  run: runCartValidationGate,
} as const;
