import type { CallSession } from "../types/order.js";
import type { CallState, CallStateAwaitingInput } from "./callStateStore.js";

export function syncSessionFromCallState(session: CallSession, state: CallState): void {
  session.productSlots = { ...state.slots };
  session.lastOrchestratorIntent = state.intent;
  session.awaitingInput = mapAwaitingToSession(state.awaitingInput);
}

function mapAwaitingToSession(
  awaiting: CallStateAwaitingInput,
): CallSession["awaitingInput"] {
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
