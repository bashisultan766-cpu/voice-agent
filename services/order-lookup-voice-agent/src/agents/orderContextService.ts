/** Sticky order context facade; sessionManager remains the single storage implementation. */
import type { CallSession } from "../types/order.js";
import {
  getActiveOrderContext,
  saveActiveOrderContext,
  type ActiveOrderContextData,
} from "./sessionManager.js";

export type StickyOrderView = ActiveOrderContextData;

export function getStickyOrder(session: CallSession): StickyOrderView | undefined {
  return getActiveOrderContext(session);
}

export function setStickyOrder(session: CallSession, view: StickyOrderView): void {
  saveActiveOrderContext(session, view);
}
