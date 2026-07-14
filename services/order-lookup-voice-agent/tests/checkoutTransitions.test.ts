import { describe, expect, it } from "vitest";
import {
  canTransition,
  doesGroupConsumeAllocation,
  transitionCheckoutGroup,
} from "../src/domain/checkoutTransitions.js";
import {
  planCheckoutGroup,
  markGroupDraftCreated,
  markGroupEmailFailed,
  markGroupEmailUnknown,
  markGroupSent,
  markGroupFailedFinal,
  removeCheckoutGroup,
  retryCheckoutGroup,
  bindConfirmedEmailToGroup,
  type CheckoutGroupStatus,
} from "../src/domain/checkoutModels.js";
import type { CallSession } from "../src/types/order.js";

function session(): CallSession {
  return {
    callSid: "CA_TRANS",
    shoppingCart: [{ variantId: "v1", productId: "p1", title: "Book", quantity: 2 }],
  } as CallSession;
}

const ALL: CheckoutGroupStatus[] = [
  "planned",
  "email_pending",
  "ready",
  "draft_created",
  "email_failed",
  "email_unknown",
  "sent",
  "cancelled",
  "failed_final",
];

describe("checkoutTransitions", () => {
  it("documents allocation consumption matrix", () => {
    expect(doesGroupConsumeAllocation("planned")).toBe(true);
    expect(doesGroupConsumeAllocation("email_pending")).toBe(true);
    expect(doesGroupConsumeAllocation("ready")).toBe(true);
    expect(doesGroupConsumeAllocation("draft_created")).toBe(true);
    expect(doesGroupConsumeAllocation("email_failed")).toBe(true);
    expect(doesGroupConsumeAllocation("email_unknown")).toBe(true);
    expect(doesGroupConsumeAllocation("sent")).toBe(false);
    expect(doesGroupConsumeAllocation("cancelled")).toBe(false);
    expect(doesGroupConsumeAllocation("failed_final")).toBe(false);
  });

  it("allows only legal transitions (exhaustive identity + listed edges)", () => {
    for (const from of ALL) {
      expect(canTransition(from, from)).toBe(true);
      for (const to of ALL) {
        if (from === to) continue;
        const allowed = canTransition(from, to);
        if (from === "sent" || from === "cancelled" || from === "failed_final") {
          expect(allowed).toBe(false);
        }
      }
    }
    expect(canTransition("planned", "ready")).toBe(true);
    expect(canTransition("draft_created", "email_unknown")).toBe(true);
    expect(canTransition("email_unknown", "sent")).toBe(true);
    expect(canTransition("email_failed", "failed_final")).toBe(true);
    expect(canTransition("sent", "cancelled")).toBe(false);
  });

  it("routes mark* helpers through transitionCheckoutGroup", () => {
    const s = session();
    const planned = planCheckoutGroup(s, [{ variantId: "v1", title: "Book", quantity: 1 }]);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const id = planned.group.checkoutGroupId;
    bindConfirmedEmailToGroup(s, id, {
      confirmedEmailId: "ce_1",
      address: "a@b.com",
      confirmedAt: Date.now(),
      workflowType: "payment_link",
    });
    expect(planned.group.status).toBe("ready");
    markGroupDraftCreated(s, id, "d1", "https://invoice");
    expect(planned.group.status).toBe("draft_created");
    markGroupEmailUnknown(s, id, "TIMEOUT", "unknown");
    expect(planned.group.status).toBe("email_unknown");
    expect(doesGroupConsumeAllocation(planned.group.status)).toBe(true);
    markGroupSent(s, id);
    expect(planned.group.status).toBe("sent");
    expect(doesGroupConsumeAllocation(planned.group.status)).toBe(false);
  });

  it("failed_final releases allocation; cancel blocks sent groups", () => {
    const s = session();
    const a = planCheckoutGroup(s, [{ variantId: "v1", title: "Book", quantity: 1 }]);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    markGroupEmailFailed(s, a.group.checkoutGroupId, "E", "fail");
    markGroupFailedFinal(s, a.group.checkoutGroupId, "FINAL", "done");
    expect(a.group.status).toBe("failed_final");
    expect(doesGroupConsumeAllocation(a.group.status)).toBe(false);
    const b = planCheckoutGroup(s, [{ variantId: "v1", title: "Book", quantity: 1 }]);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    markGroupSent(s, b.group.checkoutGroupId);
    expect(removeCheckoutGroup(s, b.group.checkoutGroupId)).toBe(false);
  });

  it("retry maps email_unknown with invoice back to draft_created", () => {
    const s = session();
    const planned = planCheckoutGroup(s, [{ variantId: "v1", title: "Book", quantity: 1 }]);
    if (!planned.ok) throw new Error(planned.message);
    markGroupDraftCreated(s, planned.group.checkoutGroupId, "d", "https://x");
    markGroupEmailUnknown(s, planned.group.checkoutGroupId, "T", "t");
    const retried = retryCheckoutGroup(s, planned.group.checkoutGroupId);
    expect(retried?.status).toBe("draft_created");
  });

  it("rejects illegal direct transitions", () => {
    const s = session();
    const planned = planCheckoutGroup(s, [{ variantId: "v1", title: "Book", quantity: 1 }]);
    if (!planned.ok) throw new Error(planned.message);
    markGroupSent(s, planned.group.checkoutGroupId);
    const bad = transitionCheckoutGroup(s, planned.group.checkoutGroupId, "ready");
    expect(bad.ok).toBe(false);
  });
});
