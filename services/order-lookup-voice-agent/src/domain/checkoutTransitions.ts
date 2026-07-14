import type { CallSession } from "../types/order.js";
import { ensureCheckoutPlan, type CheckoutGroup, type CheckoutGroupStatus } from "./checkoutModels.js";

/** `sent` is INVOICE_SENT; `email_failed` is recoverable; `failed_final` releases allocation. */
export type TerminalStatus = "sent" | "cancelled" | "failed_final";

export function doesGroupConsumeAllocation(status: CheckoutGroupStatus): boolean {
  return ["planned", "email_pending", "ready", "draft_created", "email_failed", "email_unknown"].includes(status);
}

const TRANSITIONS: Record<CheckoutGroupStatus, CheckoutGroupStatus[]> = {
  planned: ["email_pending", "ready", "draft_created", "email_failed", "email_unknown", "sent", "cancelled", "failed_final"],
  email_pending: ["ready", "draft_created", "email_failed", "email_unknown", "cancelled", "failed_final"],
  ready: ["draft_created", "email_failed", "email_unknown", "sent", "cancelled", "failed_final"],
  draft_created: ["sent", "email_failed", "email_unknown", "ready", "cancelled", "failed_final"],
  email_failed: ["draft_created", "ready", "cancelled", "failed_final"],
  email_unknown: ["sent", "email_failed", "draft_created", "ready", "failed_final"],
  sent: [],
  cancelled: [],
  failed_final: [],
};

export function canTransition(from: CheckoutGroupStatus, to: CheckoutGroupStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function transitionCheckoutGroup(
  session: CallSession,
  groupId: string,
  to: CheckoutGroupStatus,
  meta?: Partial<CheckoutGroup>,
): { ok: true; group: CheckoutGroup } | { ok: false; message: string } {
  const group = ensureCheckoutPlan(session).groups.find((entry) => entry.checkoutGroupId === groupId);
  if (!group) return { ok: false, message: "Unknown checkout_group_id." };
  if (!canTransition(group.status, to)) {
    return { ok: false, message: `Invalid checkout transition: ${group.status} → ${to}.` };
  }
  Object.assign(group, meta ?? {});
  group.status = to;
  group.updatedAt = Date.now();
  ensureCheckoutPlan(session).updatedAt = group.updatedAt;
  return { ok: true, group };
}
