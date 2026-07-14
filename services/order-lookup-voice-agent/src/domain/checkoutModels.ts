/**
 * Checkout domain models — single ownership for split / full cart payment groups.
 * Every cart line belongs to at most one active group. Groups need ConfirmedEmail.
 */
import type { CallSession, ShoppingCartLineItem } from "../types/order.js";
import { ensureSessionMemory } from "../agents/sessionMemory.js";
import { randomUUID } from "node:crypto";
import { doesGroupConsumeAllocation, transitionCheckoutGroup } from "./checkoutTransitions.js";

export type CheckoutGroupStatus =
  | "planned"
  | "email_pending"
  | "ready"
  | "draft_created"
  | "email_failed"
  | "email_unknown"
  | "sent"
  | "cancelled"
  | "failed_final";

export interface ConfirmedEmail {
  /** Opaque id issued only by EmailConfirmationManager after letter-by-letter confirm. */
  confirmedEmailId: string;
  address: string;
  confirmedAt: number;
  workflowType: "payment_link" | "support_escalation";
}

export interface CheckoutGroupLine {
  variantId: string;
  title: string;
  quantity: number;
  isbn?: string;
}

/** Quantity reservation against one concrete cart line. */
export interface CheckoutAllocation {
  cartLineId: string;
  variantId: string;
  quantity: number;
}

export interface CheckoutGroup {
  checkoutGroupId: string;
  /** Stable idempotency key — retries of the same group reuse this. */
  idempotencyKey: string;
  status: CheckoutGroupStatus;
  lines: CheckoutGroupLine[];
  /** Source-of-truth checkout quantities; `lines` remains a compatibility projection. */
  allocations: CheckoutAllocation[];
  confirmedEmailId?: string;
  draftOrderId?: string;
  invoiceUrl?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CheckoutPlan {
  planId: string;
  groups: CheckoutGroup[];
  /** Line keys (variantId) already assigned to an active/sent group. */
  assignedVariantIds: string[];
  /** Compatibility index only; quantities are computed from active allocations. */
  allocatedQuantitiesByCartLineId?: Record<string, number>;
  createdAt: number;
  updatedAt: number;
}

export interface CheckoutExecutionResult {
  ok: boolean;
  checkoutGroupId: string;
  idempotencyKey: string;
  status: CheckoutGroupStatus;
  invoiceUrl?: string;
  draftOrderId?: string;
  failureState?: string;
  message: string;
  remainingUnits?: number;
}

function isTerminalGroup(group: CheckoutGroup): boolean {
  return group.status === "sent" || group.status === "cancelled" || group.status === "failed_final";
}

function cartLineId(line: CheckoutGroupLine): string {
  return (line as CheckoutGroupLine & { cartLineId?: string }).cartLineId?.trim() || line.variantId.trim();
}

export function ensureCheckoutPlan(session: CallSession): CheckoutPlan {
  const memory = ensureSessionMemory(session);
  if (!memory.checkoutPlan) {
    memory.checkoutPlan = {
      planId: `plan_${session.callSid.slice(0, 8)}_${Date.now()}`,
      groups: [],
      assignedVariantIds: [],
      allocatedQuantitiesByCartLineId: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  return memory.checkoutPlan;
}

export function getCheckoutGroup(
  session: CallSession,
  checkoutGroupId: string,
): CheckoutGroup | undefined {
  return ensureCheckoutPlan(session).groups.find((g) => g.checkoutGroupId === checkoutGroupId);
}

function syncAllocationIndex(plan: CheckoutPlan): void {
  const amounts: Record<string, number> = {};
  for (const group of plan.groups.filter((group) => doesGroupConsumeAllocation(group.status))) {
    for (const allocation of group.allocations ?? []) {
      amounts[allocation.cartLineId] = (amounts[allocation.cartLineId] ?? 0) + allocation.quantity;
    }
  }
  plan.allocatedQuantitiesByCartLineId = amounts;
  plan.assignedVariantIds = [...new Set(
    plan.groups.filter((group) => doesGroupConsumeAllocation(group.status)).flatMap((group) => (group.allocations ?? []).map((allocation) => allocation.variantId)),
  )];
}

function allocatedQtyForLine(plan: CheckoutPlan, cartLineIdValue: string): number {
  let total = 0;
  for (const group of plan.groups.filter((group) => doesGroupConsumeAllocation(group.status))) {
    for (const allocation of group.allocations ?? []) {
      if (
        allocation.cartLineId === cartLineIdValue ||
        allocation.variantId.trim() === cartLineIdValue
      ) {
        total += allocation.quantity;
      }
    }
  }
  return total;
}

/** Test/helper export — live sum of active allocations for a cart line. */
export function getActiveAllocatedQuantity(session: CallSession, cartLineIdValue: string): number {
  return allocatedQtyForLine(ensureCheckoutPlan(session), cartLineIdValue);
}

/** Create a planned group, reserving no more than the cart-line quantity. */
export function planCheckoutGroup(
  session: CallSession,
  lines: CheckoutGroupLine[],
): { ok: true; group: CheckoutGroup } | { ok: false; message: string; failureState: string } {
  const plan = ensureCheckoutPlan(session);
  syncAllocationIndex(plan);
  const cartById = new Map(
    (session.shoppingCart ?? []).map((line) => [line.variantId.trim(), line]),
  );
  for (const line of lines) {
    const id = cartLineId(line);
    const cart = cartById.get(id) ?? cartById.get(line.variantId.trim());
    const available = cart?.quantity ?? 0;
    const allocated = allocatedQtyForLine(plan, id);
    if (!cart || line.quantity <= 0 || allocated + line.quantity > available) {
      return {
        ok: false,
        failureState: "LINE_QUANTITY_ALREADY_ASSIGNED",
        message: `Cannot allocate ${line.quantity} of ${line.variantId}; ${Math.max(0, available - allocated)} remain unassigned.`,
      };
    }
  }

  const checkoutGroupId = `cg_${randomUUID().slice(0, 12)}`;
  const group: CheckoutGroup = {
    checkoutGroupId,
    idempotencyKey: `idem_${checkoutGroupId}`,
    status: "planned",
    lines: lines.map((l) => ({ ...l })),
    allocations: lines.map((line) => ({
      cartLineId: cartLineId(line),
      variantId: line.variantId,
      quantity: line.quantity,
    })),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  plan.groups.push(group);
  syncAllocationIndex(plan);
  plan.updatedAt = Date.now();
  return { ok: true, group };
}

/** Confirms all cart units are either reserved by active groups or still unassigned. */
export function validatePlanQuantities(session: CallSession): { ok: true } | { ok: false; message: string } {
  const plan = ensureCheckoutPlan(session);
  syncAllocationIndex(plan);
  for (const line of session.shoppingCart ?? []) {
    const allocated = plan.allocatedQuantitiesByCartLineId?.[line.variantId.trim()] ?? 0;
    if (!Number.isInteger(allocated) || allocated < 0 || allocated > line.quantity) {
      return { ok: false, message: `Invalid allocation for ${line.variantId}.` };
    }
  }
  return { ok: true };
}

export function removeCheckoutGroup(session: CallSession, checkoutGroupId: string): boolean {
  const group = getCheckoutGroup(session, checkoutGroupId);
  if (!group || isTerminalGroup(group)) return false;
  if (!transitionCheckoutGroup(session, checkoutGroupId, "cancelled").ok) return false;
  syncAllocationIndex(ensureCheckoutPlan(session));
  return true;
}

export function retryCheckoutGroup(session: CallSession, checkoutGroupId: string): CheckoutGroup | undefined {
  const group = getCheckoutGroup(session, checkoutGroupId);
  if (!group || (group.status !== "email_failed" && group.status !== "email_unknown")) return undefined;
  const transitioned = transitionCheckoutGroup(session, checkoutGroupId, group.invoiceUrl ? "draft_created" : "ready");
  return transitioned.ok ? transitioned.group : undefined;
}

export function bindConfirmedEmailToGroup(
  session: CallSession,
  checkoutGroupId: string,
  confirmed: ConfirmedEmail,
): { ok: true; group: CheckoutGroup } | { ok: false; message: string; failureState: string } {
  const group = getCheckoutGroup(session, checkoutGroupId);
  if (!group) {
    return { ok: false, failureState: "GROUP_NOT_FOUND", message: "Unknown checkout_group_id." };
  }
  if (isTerminalGroup(group)) {
    return {
      ok: false,
      failureState: "GROUP_IMMUTABLE",
      message: `Group ${checkoutGroupId} is ${group.status} and cannot bind a new email.`,
    };
  }
  group.confirmedEmailId = confirmed.confirmedEmailId;
  if (!transitionCheckoutGroup(session, checkoutGroupId, "ready").ok) {
    return { ok: false, failureState: "INVALID_TRANSITION", message: "Cannot prepare this checkout group." };
  }
  ensureCheckoutPlan(session).updatedAt = Date.now();
  return { ok: true, group };
}

export function markGroupDraftCreated(
  session: CallSession,
  checkoutGroupId: string,
  draftOrderId: string,
  invoiceUrl: string,
): void {
  const group = getCheckoutGroup(session, checkoutGroupId);
  if (!group || isTerminalGroup(group)) return;
  transitionCheckoutGroup(session, checkoutGroupId, "draft_created", { draftOrderId, invoiceUrl });
}

export function markGroupEmailFailed(
  session: CallSession,
  checkoutGroupId: string,
  code: string,
  message: string,
): void {
  const group = getCheckoutGroup(session, checkoutGroupId);
  if (!group || isTerminalGroup(group)) return;
  transitionCheckoutGroup(session, checkoutGroupId, "email_failed", {
    lastErrorCode: code,
    lastErrorMessage: message,
  });
  // Preserve draftOrderId + invoiceUrl for idempotent retry.
  syncAllocationIndex(ensureCheckoutPlan(session));
}

export function markGroupEmailUnknown(
  session: CallSession,
  checkoutGroupId: string,
  code: string,
  message: string,
): void {
  const group = getCheckoutGroup(session, checkoutGroupId);
  if (!group || isTerminalGroup(group)) return;
  transitionCheckoutGroup(session, checkoutGroupId, "email_unknown", {
    lastErrorCode: code,
    lastErrorMessage: message,
  });
  syncAllocationIndex(ensureCheckoutPlan(session));
}

export function markGroupSent(session: CallSession, checkoutGroupId: string): void {
  const group = getCheckoutGroup(session, checkoutGroupId);
  if (!group || isTerminalGroup(group)) return;
  transitionCheckoutGroup(session, checkoutGroupId, "sent", {
    lastErrorCode: undefined,
    lastErrorMessage: undefined,
  });
  syncAllocationIndex(ensureCheckoutPlan(session));
}

export function markGroupFailedFinal(
  session: CallSession,
  checkoutGroupId: string,
  code: string,
  message: string,
): void {
  const group = getCheckoutGroup(session, checkoutGroupId);
  if (!group || isTerminalGroup(group)) return;
  transitionCheckoutGroup(session, checkoutGroupId, "failed_final", {
    lastErrorCode: code,
    lastErrorMessage: message,
  });
  syncAllocationIndex(ensureCheckoutPlan(session));
}

export function cartLinesToGroupLines(lines: ShoppingCartLineItem[]): CheckoutGroupLine[] {
  return lines.map((l) => ({
    variantId: l.variantId,
    title: l.title,
    quantity: l.quantity,
    isbn: l.isbn,
  }));
}

export const CheckoutDomain = {
  ensureCheckoutPlan,
  getCheckoutGroup,
  planCheckoutGroup,
  bindConfirmedEmailToGroup,
  markGroupDraftCreated,
  markGroupEmailFailed,
  markGroupEmailUnknown,
  markGroupSent,
  markGroupFailedFinal,
  cartLinesToGroupLines,
  validatePlanQuantities,
  removeCheckoutGroup,
  retryCheckoutGroup,
} as const;
