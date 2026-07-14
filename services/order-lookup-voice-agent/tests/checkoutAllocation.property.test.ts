import { describe, expect, it } from "vitest";
import {
  planCheckoutGroup,
  validatePlanQuantities,
  removeCheckoutGroup,
  retryCheckoutGroup,
  markGroupSent,
  markGroupEmailFailed,
  markGroupFailedFinal,
  markGroupEmailUnknown,
  markGroupDraftCreated,
  ensureCheckoutPlan,
  getActiveAllocatedQuantity,
} from "../src/domain/checkoutModels.js";
import { doesGroupConsumeAllocation } from "../src/domain/checkoutTransitions.js";
import type { CallSession } from "../src/types/order.js";

function makeCart(lines: Array<{ id: string; qty: number }>): CallSession {
  return {
    callSid: `CA_${Math.random().toString(36).slice(2, 10)}`,
    shoppingCart: lines.map((line) => ({
      variantId: line.id,
      productId: `p-${line.id}`,
      title: `Book ${line.id}`,
      quantity: line.qty,
    })),
  } as CallSession;
}

function assertAllocationInvariant(session: CallSession): void {
  const check = validatePlanQuantities(session);
  if (!check.ok) {
    const plan = ensureCheckoutPlan(session);
    throw new Error(
      `${check.message} :: ${JSON.stringify(plan.allocatedQuantitiesByCartLineId)} :: groups=${JSON.stringify(
        plan.groups.map((g) => ({ id: g.checkoutGroupId, status: g.status, allocations: g.allocations })),
      )}`,
    );
  }
  for (const line of session.shoppingCart ?? []) {
    const allocated = getActiveAllocatedQuantity(session, line.variantId);
    expect(allocated).toBeGreaterThanOrEqual(0);
    expect(allocated).toBeLessThanOrEqual(line.quantity);
  }
}

describe("quantity-aware checkout allocations (property)", () => {
  it("allows a four-unit cart line to split 2 + 2 but not exceed four", () => {
    const session = makeCart([{ id: "v1", qty: 4 }]);
    expect(planCheckoutGroup(session, [{ variantId: "v1", title: "Book", quantity: 2 }]).ok).toBe(true);
    expect(planCheckoutGroup(session, [{ variantId: "v1", title: "Book", quantity: 2 }]).ok).toBe(true);
    expect(planCheckoutGroup(session, [{ variantId: "v1", title: "Book", quantity: 1 }]).ok).toBe(false);
    assertAllocationInvariant(session);
  });

  it("rejects over-allocation when a ready group already holds quantity", () => {
    const session = makeCart([{ id: "v0", qty: 5 }]);
    const first = planCheckoutGroup(session, [{ variantId: "v0", title: "Book", quantity: 4 }]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    markGroupEmailFailed(session, first.group.checkoutGroupId, "TEST", "x");
    retryCheckoutGroup(session, first.group.checkoutGroupId);
    expect(planCheckoutGroup(session, [{ variantId: "v0", title: "Book", quantity: 3 }]).ok).toBe(false);
    assertAllocationInvariant(session);
  });

  it("three-way split across a six-unit line", () => {
    const session = makeCart([{ id: "v3", qty: 6 }]);
    expect(planCheckoutGroup(session, [{ variantId: "v3", title: "Book", quantity: 2 }]).ok).toBe(true);
    expect(planCheckoutGroup(session, [{ variantId: "v3", title: "Book", quantity: 2 }]).ok).toBe(true);
    expect(planCheckoutGroup(session, [{ variantId: "v3", title: "Book", quantity: 2 }]).ok).toBe(true);
    expect(planCheckoutGroup(session, [{ variantId: "v3", title: "Book", quantity: 1 }]).ok).toBe(false);
    assertAllocationInvariant(session);
  });

  it("sent + draft conflict: sent releases, draft still consumes", () => {
    const session = makeCart([{ id: "v2", qty: 3 }]);
    const a = planCheckoutGroup(session, [{ variantId: "v2", title: "Book", quantity: 2 }]);
    const b = planCheckoutGroup(session, [{ variantId: "v2", title: "Book", quantity: 1 }]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    markGroupSent(session, a.group.checkoutGroupId);
    markGroupDraftCreated(session, b.group.checkoutGroupId, "d", "https://x");
    expect(doesGroupConsumeAllocation(a.group.status)).toBe(false);
    expect(doesGroupConsumeAllocation(b.group.status)).toBe(true);
    expect(getActiveAllocatedQuantity(session, "v2")).toBe(1);
    expect(planCheckoutGroup(session, [{ variantId: "v2", title: "Book", quantity: 3 }]).ok).toBe(false);
    expect(planCheckoutGroup(session, [{ variantId: "v2", title: "Book", quantity: 2 }]).ok).toBe(true);
    assertAllocationInvariant(session);
  });

  it("failed_final releases allocation for replanning", () => {
    const session = makeCart([{ id: "v4", qty: 2 }]);
    const g = planCheckoutGroup(session, [{ variantId: "v4", title: "Book", quantity: 2 }]);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    markGroupFailedFinal(session, g.group.checkoutGroupId, "FINAL", "permanent");
    expect(getActiveAllocatedQuantity(session, "v4")).toBe(0);
    expect(planCheckoutGroup(session, [{ variantId: "v4", title: "Book", quantity: 2 }]).ok).toBe(true);
    assertAllocationInvariant(session);
  });

  it("email_unknown retains allocation", () => {
    const session = makeCart([{ id: "v5", qty: 2 }]);
    const g = planCheckoutGroup(session, [{ variantId: "v5", title: "Book", quantity: 2 }]);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    markGroupDraftCreated(session, g.group.checkoutGroupId, "d", "https://x");
    markGroupEmailUnknown(session, g.group.checkoutGroupId, "TIMEOUT", "unknown");
    expect(doesGroupConsumeAllocation(g.group.status)).toBe(true);
    expect(getActiveAllocatedQuantity(session, "v5")).toBe(2);
    expect(planCheckoutGroup(session, [{ variantId: "v5", title: "Book", quantity: 1 }]).ok).toBe(false);
    assertAllocationInvariant(session);
  });

  it("random carts: allocations never exceed line quantity across groups/moves/retries", () => {
    for (let trial = 0; trial < 50; trial++) {
      const lineCount = 1 + Math.floor(Math.random() * 5);
      const lines = Array.from({ length: lineCount }, (_, i) => ({
        id: `v${i}`,
        qty: 1 + Math.floor(Math.random() * 8),
      }));
      const session = makeCart(lines);
      const groupIds: string[] = [];

      for (let step = 0; step < 15; step++) {
        const action = Math.floor(Math.random() * 4);
        const plan = ensureCheckoutPlan(session);

        if (action === 0) {
          const cartLine = session.shoppingCart![Math.floor(Math.random() * session.shoppingCart!.length)]!;
          const allocated = getActiveAllocatedQuantity(session, cartLine.variantId);
          const avail = cartLine.quantity - allocated;
          if (avail <= 0) continue;
          const qty = 1 + Math.floor(Math.random() * avail);
          const planned = planCheckoutGroup(session, [
            { variantId: cartLine.variantId, title: cartLine.title, quantity: qty },
          ]);
          expect(planned.ok).toBe(true);
          if (planned.ok) groupIds.push(planned.group.checkoutGroupId);
        } else if (action === 1 && groupIds.length) {
          const id = groupIds[Math.floor(Math.random() * groupIds.length)]!;
          removeCheckoutGroup(session, id);
        } else if (action === 2 && groupIds.length) {
          const id = groupIds[Math.floor(Math.random() * groupIds.length)]!;
          const group = plan.groups.find((g) => g.checkoutGroupId === id);
          if (group && group.status !== "sent" && group.status !== "cancelled" && group.status !== "failed_final") {
            markGroupEmailFailed(session, id, "TEST", "fail");
            retryCheckoutGroup(session, id);
          }
        } else if (action === 3 && groupIds.length) {
          const id = groupIds[Math.floor(Math.random() * groupIds.length)]!;
          const group = plan.groups.find((g) => g.checkoutGroupId === id);
          if (group && group.status !== "sent" && group.status !== "cancelled" && group.status !== "failed_final") {
            markGroupSent(session, id);
          }
        }

        assertAllocationInvariant(session);
      }
    }
  });
});
