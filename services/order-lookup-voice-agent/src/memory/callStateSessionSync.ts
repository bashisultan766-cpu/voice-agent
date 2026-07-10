import type { CallSession } from "../types/order.js";
import type { CallState, CallStateAwaitingInput } from "./callStateStore.js";

/**
 * Project CallState slots onto CallSession — one-way sync into the unified hub.
 * Prefer CallSession as source of truth after this write.
 */
export function syncSessionFromCallState(session: CallSession, state: CallState): void {
  session.productSlots = { ...state.slots };
  session.lastOrchestratorIntent = state.intent;
  session.awaitingInput = mapAwaitingToSession(state.awaitingInput, state);

  if (state.intent === "product") {
    session.flowMode = "PURCHASE_FLOW";
    session.activeWorkflowContext = "product_search";
    if (session.sovereignState !== "cart_active" && session.sovereignState !== "checkout_active") {
      session.sovereignState = "catalog_active";
    }
  } else if (state.intent === "order" || state.awaitingInput === "order_number") {
    if (session.flowMode !== "PURCHASE_FLOW") {
      session.flowMode = "SUPPORT_FLOW";
      session.activeWorkflowContext = "order_lookup";
    }
  }
}

function mapAwaitingToSession(
  awaiting: CallStateAwaitingInput,
  state: CallState,
): CallSession["awaitingInput"] {
  if (state.slotFlags.isbnCollected && state.slots.isbn) {
    return null;
  }
  if (state.slotFlags.titleCollected && state.slots.title) {
    return null;
  }
  switch (awaiting) {
    case "order_number":
      return "order_number";
    case "isbn_or_title":
    case "isbn":
    case "title":
      return "product_slot";
    default:
      return null;
  }
}
