import type { CallSession } from "../types/order.js";
import type { CallState, CallStateAwaitingInput } from "./callStateStore.js";

export function syncSessionFromCallState(session: CallSession, state: CallState): void {
  session.productSlots = { ...state.slots };
  session.lastOrchestratorIntent = state.intent;
  session.awaitingInput = mapAwaitingToSession(state.awaitingInput, state);
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
