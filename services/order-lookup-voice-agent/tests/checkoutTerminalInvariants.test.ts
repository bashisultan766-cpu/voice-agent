import { describe, expect, it } from "vitest";
import type { CallSession } from "../src/types/order.js";
import {
  bindConfirmedEmailToGroup,
  markGroupDraftCreated,
  markGroupEmailFailed,
  markGroupEmailUnknown,
  markGroupFailedFinal,
  markGroupSent,
  planCheckoutGroup,
  removeCheckoutGroup,
  retryCheckoutGroup,
  type CheckoutGroupStatus,
} from "../src/domain/checkoutModels.js";
import { doesGroupConsumeAllocation } from "../src/domain/checkoutTransitions.js";

function makeSession(): CallSession {
  return {
    callSid: "CA_TERMINAL",
    shoppingCart: [{ variantId: "v1", productId: "p1", title: "Book", quantity: 1 }],
  } as CallSession;
}

function terminalGroup(status: CheckoutGroupStatus) {
  const session = makeSession();
  const planned = planCheckoutGroup(session, [{ variantId: "v1", title: "Book", quantity: 1 }]);
  if (!planned.ok) throw new Error(planned.message);
  const id = planned.group.checkoutGroupId;
  if (status === "sent") markGroupSent(session, id);
  if (status === "cancelled") removeCheckoutGroup(session, id);
  if (status === "failed_final") markGroupFailedFinal(session, id, "FINAL", "terminal");
  return { session, group: planned.group, id };
}

describe("checkout terminal mutation invariants", () => {
  for (const status of ["sent", "cancelled", "failed_final"] as const) {
    it(`${status} rejects every checkout mutation`, () => {
      const { session, group, id } = terminalGroup(status);
      const before = JSON.stringify(group);
      expect(bindConfirmedEmailToGroup(session, id, {
        confirmedEmailId: "ce_x", address: "new@example.com", confirmedAt: Date.now(), workflowType: "payment_link",
      }).ok).toBe(false);
      markGroupDraftCreated(session, id, "draft_x", "https://invoice.example/x");
      markGroupEmailFailed(session, id, "FAILED", "fail");
      markGroupEmailUnknown(session, id, "UNKNOWN", "unknown");
      markGroupSent(session, id);
      expect(retryCheckoutGroup(session, id)).toBeUndefined();
      expect(removeCheckoutGroup(session, id)).toBe(false);
      expect(group.status).toBe(status);
      expect(JSON.stringify(group)).toBe(before);
    });
  }

  it("email_unknown retains allocation while cancelled and failed_final release it", () => {
    const unknown = terminalGroup("sent");
    // A separate active group exercises the recoverable unknown state.
    const active = makeSession();
    const planned = planCheckoutGroup(active, [{ variantId: "v1", title: "Book", quantity: 1 }]);
    if (!planned.ok) throw new Error(planned.message);
    markGroupEmailUnknown(active, planned.group.checkoutGroupId, "TIMEOUT", "timeout");
    expect(doesGroupConsumeAllocation(planned.group.status)).toBe(true);
    expect(doesGroupConsumeAllocation(unknown.group.status)).toBe(false);
    expect(doesGroupConsumeAllocation(terminalGroup("cancelled").group.status)).toBe(false);
    expect(doesGroupConsumeAllocation(terminalGroup("failed_final").group.status)).toBe(false);
  });
});
