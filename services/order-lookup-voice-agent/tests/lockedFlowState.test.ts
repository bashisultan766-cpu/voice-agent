import { describe, expect, it } from "vitest";
import {
  buildLockedFlowSystemMessage,
  isLockedFlowState,
  isPaymentLinkActionUtterance,
} from "../src/agents/lockedFlowState.js";
import type { CallSession } from "../src/types/order.js";

describe("lockedFlowState", () => {
  it("detects active cart and pending invoice as locked flow", () => {
    expect(
      isLockedFlowState({
        shoppingCart: [{ title: "Book", quantity: 1, unitPrice: "12" }],
      } as CallSession),
    ).toBe(true);
    expect(
      isLockedFlowState({
        pendingInvoiceUrl: "https://checkout.example/invoice",
      } as CallSession),
    ).toBe(true);
    expect(isLockedFlowState({} as CallSession)).toBe(false);
  });

  it("detects payment link requests and confirmations", () => {
    expect(isPaymentLinkActionUtterance("Send me the payment link")).toBe(true);
    expect(isPaymentLinkActionUtterance("Yes, email the checkout link")).toBe(true);
    expect(isPaymentLinkActionUtterance("goodbye")).toBe(false);
  });

  it("builds locked-flow system message when cart is active", () => {
    const message = buildLockedFlowSystemMessage({
      shoppingCart: [{ title: "Book", quantity: 1, unitPrice: "12" }],
    } as CallSession);
    expect(message).toMatch(/LOCKED FLOW STATE/i);
    expect(message).toMatch(/end_call tool is DISABLED/i);
  });
});
