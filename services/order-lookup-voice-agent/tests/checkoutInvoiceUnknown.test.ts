import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  markGroupDraftCreated,
  markGroupEmailUnknown,
  markGroupEmailFailed,
  markGroupSent,
  planCheckoutGroup,
  retryCheckoutGroup,
  getActiveAllocatedQuantity,
  getCheckoutGroup,
  ensureCheckoutPlan,
} from "../src/domain/checkoutModels.js";
import { canTransition, transitionCheckoutGroup } from "../src/domain/checkoutTransitions.js";
import type { CallSession } from "../src/types/order.js";

function session(callSid = "CA_UNKNOWN"): CallSession {
  return {
    callSid,
    shoppingCart: [{ variantId: "v1", productId: "p1", title: "Book", quantity: 2 }],
  } as CallSession;
}

function planOne(s: CallSession) {
  const planned = planCheckoutGroup(s, [{ variantId: "v1", title: "Book", quantity: 1 }]);
  if (!planned.ok) throw new Error(planned.message);
  return planned.group;
}

describe("unknown invoice delivery reconciliation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("provider success with normal response → sent", () => {
    const s = session();
    const group = planOne(s);
    markGroupDraftCreated(s, group.checkoutGroupId, "draft-ok", "https://invoice.example/ok");
    markGroupSent(s, group.checkoutGroupId);
    expect(group.status).toBe("sent");
    expect(group.invoiceUrl).toBe("https://invoice.example/ok");
  });

  it("provider confirmed failure → email_failed then recoverable retry", () => {
    const s = session();
    const group = planOne(s);
    markGroupDraftCreated(s, group.checkoutGroupId, "draft-fail", "https://invoice.example/f");
    markGroupEmailFailed(s, group.checkoutGroupId, "PROVIDER_REJECT", "550 bounce");
    expect(group.status).toBe("email_failed");
    const retried = retryCheckoutGroup(s, group.checkoutGroupId);
    expect(retried?.status).toBe("draft_created");
    expect(retried?.draftOrderId).toBe("draft-fail");
  });

  it("timeout before provider acceptance → email_unknown preserves draft", () => {
    const s = session();
    const group = planOne(s);
    markGroupDraftCreated(s, group.checkoutGroupId, "draft-1", "https://invoice.example/1");
    markGroupEmailUnknown(s, group.checkoutGroupId, "TIMEOUT", "delivery timed out");
    expect(group.status).toBe("email_unknown");
    expect(group.invoiceUrl).toBe("https://invoice.example/1");
    expect(group.draftOrderId).toBe("draft-1");
    expect(getActiveAllocatedQuantity(s, "v1")).toBe(1);
  });

  it("provider success with lost response → unknown then reconcile to sent", () => {
    const s = session();
    const group = planOne(s);
    markGroupDraftCreated(s, group.checkoutGroupId, "draft-lost", "https://invoice.example/lost");
    markGroupEmailUnknown(s, group.checkoutGroupId, "LOST_RESPONSE", "accepted but no ack");
    markGroupSent(s, group.checkoutGroupId);
    expect(group.status).toBe("sent");
    expect(group.invoiceUrl).toBe("https://invoice.example/lost");
    expect(getActiveAllocatedQuantity(s, "v1")).toBe(0);
  });

  it("process crash after send: persisted metadata allows restart reconcile to sent", () => {
    const s = session("CA_CRASH");
    const group = planOne(s);
    markGroupDraftCreated(s, group.checkoutGroupId, "draft-crash", "https://invoice.example/crash");
    markGroupEmailUnknown(s, group.checkoutGroupId, "PROCESS_CRASH", "died after POST");
    // Simulate restart: reload plan from session memory and reconcile.
    const reloaded = getCheckoutGroup(s, group.checkoutGroupId);
    expect(reloaded?.draftOrderId).toBe("draft-crash");
    expect(reloaded?.status).toBe("email_unknown");
    markGroupSent(s, group.checkoutGroupId);
    expect(getCheckoutGroup(s, group.checkoutGroupId)?.status).toBe("sent");
  });

  it("retry finds already-sent invoice → sent stays terminal", () => {
    const s = session();
    const group = planOne(s);
    markGroupDraftCreated(s, group.checkoutGroupId, "d", "https://x");
    markGroupSent(s, group.checkoutGroupId);
    expect(canTransition("sent", "draft_created")).toBe(false);
    expect(retryCheckoutGroup(s, group.checkoutGroupId)).toBeUndefined();
    expect(group.status).toBe("sent");
  });

  it("retry safely sends when invoice is confirmed absent (unknown → failed → retry)", () => {
    const s = session();
    const group = planOne(s);
    markGroupDraftCreated(s, group.checkoutGroupId, "d", "https://x");
    markGroupEmailUnknown(s, group.checkoutGroupId, "TIMEOUT", "t");
    markGroupEmailFailed(s, group.checkoutGroupId, "ABSENT", "not found at provider");
    const retried = retryCheckoutGroup(s, group.checkoutGroupId);
    expect(retried?.status).toBe("draft_created");
    expect(retried?.invoiceUrl).toBe("https://x");
  });

  it("duplicate concurrent retries keep a single draftOrderId", () => {
    const s = session();
    const group = planOne(s);
    markGroupDraftCreated(s, group.checkoutGroupId, "draft-shared", "https://invoice.example/shared");
    markGroupEmailUnknown(s, group.checkoutGroupId, "TIMEOUT", "race");
    markGroupEmailFailed(s, group.checkoutGroupId, "RACE", "retry");
    const a = retryCheckoutGroup(s, group.checkoutGroupId);
    // Second retry while already draft_created is a no-op (no duplicate draft).
    const b = retryCheckoutGroup(s, group.checkoutGroupId);
    expect(a?.draftOrderId).toBe("draft-shared");
    expect(b).toBeUndefined();
    expect(group.draftOrderId).toBe("draft-shared");
    expect(ensureCheckoutPlan(s).groups.filter((g) => g.draftOrderId === "draft-shared")).toHaveLength(1);
  });

  it("existing Shopify draft reused by idempotency key", () => {
    const s = session();
    const group = planOne(s);
    const key = group.idempotencyKey;
    markGroupDraftCreated(s, group.checkoutGroupId, "draft-idem", "https://invoice.example/idem");
    markGroupEmailUnknown(s, group.checkoutGroupId, "TIMEOUT", "t");
    markGroupEmailFailed(s, group.checkoutGroupId, "SEND", "failed");
    const retried = retryCheckoutGroup(s, group.checkoutGroupId);
    expect(retried?.idempotencyKey).toBe(key);
    expect(retried?.draftOrderId).toBe("draft-idem");
  });

  it("sent group never sends again (terminal)", () => {
    const s = session();
    const group = planOne(s);
    markGroupDraftCreated(s, group.checkoutGroupId, "d", "https://x");
    markGroupSent(s, group.checkoutGroupId);
    expect(transitionCheckoutGroup(s, group.checkoutGroupId, "email_unknown").ok).toBe(false);
    expect(transitionCheckoutGroup(s, group.checkoutGroupId, "draft_created").ok).toBe(false);
    expect(group.status).toBe("sent");
  });

  it("uncertain result never creates a duplicate draft order", () => {
    const s = session();
    const group = planOne(s);
    markGroupDraftCreated(s, group.checkoutGroupId, "draft-only", "https://invoice.example/only");
    markGroupEmailUnknown(s, group.checkoutGroupId, "UNCERTAIN", "maybe sent");
    const plan = ensureCheckoutPlan(s);
    const drafts = plan.groups.filter((g) => g.draftOrderId === "draft-only");
    expect(drafts).toHaveLength(1);
    // Planning another group for remaining qty must not clone the unknown group's draft.
    const next = planCheckoutGroup(s, [{ variantId: "v1", title: "Book", quantity: 1 }]);
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.group.draftOrderId).toBeUndefined();
      expect(next.group.checkoutGroupId).not.toBe(group.checkoutGroupId);
    }
  });

  it("email_unknown retains allocation until sent or failed_final", () => {
    const s = session();
    const group = planOne(s);
    markGroupDraftCreated(s, group.checkoutGroupId, "d", "https://x");
    markGroupEmailUnknown(s, group.checkoutGroupId, "NET", "abort");
    expect(planCheckoutGroup(s, [{ variantId: "v1", title: "Book", quantity: 2 }]).ok).toBe(false);
    expect(getActiveAllocatedQuantity(s, "v1")).toBe(1);
  });

  it("cancelled unknown path releases when cancelled from recoverable states", () => {
    const s = session();
    const group = planOne(s);
    markGroupDraftCreated(s, group.checkoutGroupId, "d", "https://x");
    markGroupEmailFailed(s, group.checkoutGroupId, "SEND", "failed");
    expect(transitionCheckoutGroup(s, group.checkoutGroupId, "cancelled").ok).toBe(true);
    expect(group.status).toBe("cancelled");
    expect(getActiveAllocatedQuantity(s, "v1")).toBe(0);
  });
});
