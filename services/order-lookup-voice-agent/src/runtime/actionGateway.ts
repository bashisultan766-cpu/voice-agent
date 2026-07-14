/**
 * ActionGateway — sole owner of external side effects.
 * LLM tools and orchestrator propose actions; only this module may call Shopify/Resend/webhooks.
 */
import type { CallSession } from "../types/order.js";
import { logger } from "../utils/logger.js";
import {
  bindConfirmedEmailToGroup,
  ensureCheckoutPlan,
  getCheckoutGroup,
  markGroupDraftCreated,
  markGroupEmailFailed,
  markGroupEmailUnknown,
  markGroupSent,
  type CheckoutExecutionResult,
} from "../domain/checkoutModels.js";
import { getConfirmedEmailById } from "../agents/emailConfirmationManager.js";
import { createShopifyDraftOrder } from "../infra/shopifyDraftOrderClient.js";
import { isValidEmail } from "../utils/emailUtils.js";
import { isEmailDeliveryConfigured } from "../utils/emailDeliveryConfig.js";
import { sendCheckoutEmail } from "../infra/checkoutInvoiceEmailClient.js";
import {
  getDefaultCheckoutOperationRepository,
  type CheckoutOperationRepository,
} from "../domain/checkoutOperation.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { clearFailureState, recordFailureState } from "../agents/failureState.js";
import { runCartValidationGate } from "../agents/cartValidationGate.js";
import { assertLeaseValid, renewFlowMutex, withFlowMutex } from "../agents/flowMutex.js";
import { deductCheckedOutItems, getCartSummary, resolveCheckoutLineItems } from "../agents/cartManager.js";
import { resetEmailConfirmation } from "../agents/emailConfirmationManager.js";

export type ActionName =
  | "execute_checkout_group"
  | "send_support_email"
  | "escalate_to_human_webhook"
  | "shopify_order_lookup"
  | "shopify_product_search"
  | "shopify_customer_history"
  | "shopify_inventory_refresh";

export interface ActionContext {
  callId: string;
  turnId?: string;
  workflowId?: string;
  stateVersion?: number;
  actionId: string;
  idempotencyKey?: string;
}

let CACHED_LEASE_OWNER_ID: string | null = null;
/** Stable identifier for this worker/process — used as the durable lease owner. */
function currentLeaseOwnerId(): string {
  if (CACHED_LEASE_OWNER_ID) return CACHED_LEASE_OWNER_ID;
  const host = (() => {
    try {
      return hostname();
    } catch {
      return "unknown-host";
    }
  })();
  const pid = process.pid ?? 0;
  const workerId = process.env.WORKER_ID?.trim() || process.env.HOSTNAME?.trim() || host;
  CACHED_LEASE_OWNER_ID = `${workerId}:${pid}`;
  return CACHED_LEASE_OWNER_ID;
}

function logAction(
  ctx: ActionContext,
  action: ActionName,
  phase: "start" | "ok" | "error",
  meta?: Record<string, unknown>,
): void {
  logger.info(`action_gateway_${phase}`, {
    call_id: ctx.callId.slice(0, 12),
    turn_id: ctx.turnId,
    workflow_id: ctx.workflowId,
    state_version: ctx.stateVersion,
    action_id: ctx.actionId,
    idempotency_key: ctx.idempotencyKey,
    action,
    ...meta,
  });
}

export interface ExecuteCheckoutGroupInput {
  session: CallSession;
  checkoutGroupId: string;
  confirmedEmailId: string;
  customerName?: string;
  liveInventory?: Record<string, number>;
  inventoryUnavailable?: boolean;
  facilityType?: string;
  /** Test hook — durable operation store; defaults to process-wide repository. */
  checkoutOperationRepository?: CheckoutOperationRepository;
}

export async function escalateToHuman(
  session: CallSession,
  reason: string,
  ctx: ActionContext,
): Promise<
  | { ok: true; caseId: string; notified: boolean }
  | { ok: false; error: string; caseId?: string; speech: string }
> {
  logAction(ctx, "escalate_to_human_webhook", "start");
  const { createCase } = await import("../agents/supportCaseService.js");
  const {
    withFlowMutex,
    acquireFlowMutex,
    ESCALATION_FAILURE_SPEECH,
  } = await import("../agents/flowMutex.js");

  let created: Awaited<ReturnType<typeof createCase>>;
  try {
    // Critical section: always release via withFlowMutex finally — even on throw/fail.
    created = await withFlowMutex(session, "sentiment_escalation", reason, async () =>
      createCase({
        session,
        reason,
        requestId: ctx.actionId ?? ctx.idempotencyKey ?? `esc_${randomUUID().slice(0, 12)}`,
        callId: ctx.callId,
        turnId: ctx.turnId,
      }),
    );
  } catch (err) {
    logAction(ctx, "escalate_to_human_webhook", "error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: ESCALATION_FAILURE_SPEECH, speech: ESCALATION_FAILURE_SPEECH };
  }

  if (!created.ok) {
    logAction(ctx, "escalate_to_human_webhook", "error", { error: created.error });
    return {
      ok: false,
      error: created.error || ESCALATION_FAILURE_SPEECH,
      caseId: created.caseId,
      speech: ESCALATION_FAILURE_SPEECH,
    };
  }

  // Success: re-acquire durable sentiment ownership until TTL / stale breaker.
  acquireFlowMutex(session, "sentiment_escalation", reason);
  const memory = (await import("../agents/sessionMemory.js")).ensureSessionMemory(session);
  memory.sentimentShieldActive = true;
  memory.humanEscalationTriggered = true;

  logAction(ctx, "escalate_to_human_webhook", "ok", {
    caseId: created.caseId,
    notified: created.webhookNotified,
  });
  return { ok: true, caseId: created.caseId, notified: created.webhookNotified };
}

export async function createSupportCase(
  request: Parameters<typeof import("../agents/supportCaseService.js").createCase>[0],
  ctx: ActionContext,
): Promise<Awaited<ReturnType<typeof import("../agents/supportCaseService.js").createCase>>> {
  logAction(ctx, "send_support_email", "start");
  const { createCase } = await import("../agents/supportCaseService.js");
  const {
    withFlowMutex,
    acquireFlowMutex,
    ESCALATION_FAILURE_SPEECH,
  } = await import("../agents/flowMutex.js");

  const { requestId: _stripped, ...restRequest } = request as typeof request & {
    requestId?: string;
  };
  void _stripped;
  const requestId = ctx.actionId ?? ctx.idempotencyKey ?? `case_${randomUUID().slice(0, 12)}`;
  const session = request.session;

  let result: Awaited<ReturnType<typeof createCase>>;
  try {
    result = await withFlowMutex(session, "support", "create_support_case", async () =>
      createCase({
        ...restRequest,
        session,
        requestId,
        callId: ctx.callId,
        turnId: ctx.turnId,
      }),
    );
  } catch (err) {
    logAction(ctx, "send_support_email", "error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      error: ESCALATION_FAILURE_SPEECH,
    } as Awaited<ReturnType<typeof createCase>>;
  }

  if (!result.ok) {
    logAction(ctx, "send_support_email", "error", { caseId: result.caseId });
    return {
      ...result,
      error: result.error || ESCALATION_FAILURE_SPEECH,
    };
  }

  // Durable support ownership after successful case creation.
  acquireFlowMutex(session, "support", "create_support_case");
  const memory = (await import("../agents/sessionMemory.js")).ensureSessionMemory(session);
  memory.sentimentShieldActive = true;
  memory.humanEscalationTriggered = true;

  logAction(ctx, "send_support_email", "ok", { caseId: result.caseId });
  return result;
}

/**
 * Execute one checkout group: validate → DraftOrder → email invoice.
 * Idempotent on group.idempotencyKey — resent groups return prior success.
 */
export async function executeCheckoutGroup(
  input: ExecuteCheckoutGroupInput,
  ctx: ActionContext,
): Promise<CheckoutExecutionResult> {
  const { session, checkoutGroupId, confirmedEmailId } = input;
  const repository = input.checkoutOperationRepository ?? getDefaultCheckoutOperationRepository();
  logAction(ctx, "execute_checkout_group", "start", { checkoutGroupId, confirmedEmailId });

  return withFlowMutex(session, "checkout", "execute_checkout_group", async (lease) => {
    const group = getCheckoutGroup(session, checkoutGroupId);
    if (!group) {
      recordFailureState(session, "GROUP_NOT_FOUND", "Unknown checkout_group_id.", "execute_checkout_group");
      return {
        ok: false,
        checkoutGroupId,
        idempotencyKey: ctx.idempotencyKey ?? "",
        status: "cancelled",
        failureState: "GROUP_NOT_FOUND",
        message: "Unknown checkout_group_id.",
      };
    }

    // Idempotent: already sent — do not recreate.
    if (group.status === "sent" && group.invoiceUrl) {
      return {
        ok: true,
        checkoutGroupId,
        idempotencyKey: group.idempotencyKey,
        status: "sent",
        invoiceUrl: group.invoiceUrl,
        draftOrderId: group.draftOrderId,
        message: "Payment link was already sent for this checkout group.",
        remainingUnits: getCartSummary(session).totalUnits,
      };
    }

    const confirmed = getConfirmedEmailById(session, confirmedEmailId);
    if (!confirmed) {
      recordFailureState(
        session,
        "EMAIL_UNCONFIRMED",
        "confirmed_email_id is missing or not issued by EmailConfirmationManager.",
        "execute_checkout_group",
      );
      return {
        ok: false,
        checkoutGroupId,
        idempotencyKey: group.idempotencyKey,
        status: group.status,
        failureState: "EMAIL_UNCONFIRMED",
        message: "confirmed_email_id required — complete letter-by-letter email confirmation first.",
      };
    }

    if (group.confirmedEmailId && group.confirmedEmailId !== confirmedEmailId) {
      recordFailureState(
        session,
        "EMAIL_MISMATCH",
        "confirmed_email_id does not match this checkout group.",
        "execute_checkout_group",
      );
      return {
        ok: false,
        checkoutGroupId,
        idempotencyKey: group.idempotencyKey,
        status: group.status,
        failureState: "EMAIL_MISMATCH",
        message: "confirmed_email_id does not match this checkout group.",
      };
    }

    const isEmailRetry = group.status === "email_failed" || group.status === "email_unknown";
    bindConfirmedEmailToGroup(session, checkoutGroupId, confirmed);

    if (!isValidEmail(confirmed.address)) {
      recordFailureState(session, "EMAIL_INVALID", "Confirmed email address is invalid.", "execute_checkout_group");
      return {
        ok: false,
        checkoutGroupId,
        idempotencyKey: group.idempotencyKey,
        status: group.status,
        failureState: "EMAIL_INVALID",
        message: "Confirmed email address is invalid.",
      };
    }

    const selectors = group.lines.map((l) => ({
      variant_id: l.variantId,
      title: l.title,
      quantity: l.quantity,
    }));

    const gate = runCartValidationGate(session, {
      selectors,
      liveInventory: input.liveInventory,
      inventoryUnavailable: input.inventoryUnavailable,
      facilityType: input.facilityType ?? session.facilityType,
      requireConfirmedEmail: false, // confirmed_email_id already validated
      skipFailureAckCheck: isEmailRetry, // allow idempotent retry with the preserved draft
    });
    if (!gate.ok) {
      recordFailureState(
        session,
        gate.failureState ?? "CART_VALIDATION",
        gate.message,
        "execute_checkout_group",
      );
      return {
        ok: false,
        checkoutGroupId,
        idempotencyKey: group.idempotencyKey,
        status: group.status,
        failureState: gate.failureState,
        message: gate.message,
      };
    }

    const resolved = resolveCheckoutLineItems(session, gate.selectors ?? selectors);
    if (!resolved.ok || !resolved.items.length) {
      recordFailureState(session, "PARTITION_UNRESOLVED", resolved.ok ? "Empty partition." : resolved.message);
      return {
        ok: false,
        checkoutGroupId,
        idempotencyKey: group.idempotencyKey,
        status: group.status,
        failureState: "PARTITION_UNRESOLVED",
        message: resolved.ok ? "Empty partition." : resolved.message,
      };
    }

    if (!isEmailDeliveryConfigured()) {
      recordFailureState(session, "EMAIL_SERVICE", "Email service is not configured.");
      return {
        ok: false,
        checkoutGroupId,
        idempotencyKey: group.idempotencyKey,
        status: group.status,
        failureState: "EMAIL_SERVICE",
        message: "Email service is not configured.",
      };
    }

    // Retry path: reuse preserved draft/invoice when email previously failed.
    let invoiceUrl = group.invoiceUrl;
    let draftOrderId = group.draftOrderId;

    // Durable CheckoutOperation: persist STARTED before any external side effect.
    // If a prior attempt already created a draft or sent an invoice, reuse it
    // instead of duplicating on Shopify / Resend.
    const idempotencyKey = ctx.idempotencyKey ?? group.idempotencyKey;
    const leaseOwnerId = currentLeaseOwnerId();
    let operation = await repository.findByIdempotencyKey(idempotencyKey);
    if (!operation) {
      operation = await repository.create({
        operationId: `op_${randomUUID().slice(0, 12)}`,
        idempotencyKey,
        checkoutPlanId: group.checkoutGroupId,
        checkoutGroupId,
        attempt: 1,
        lifecycleStatus: "started",
        expectedPlanVersion: group.updatedAt,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        leaseToken: lease.leaseToken,
        leaseOwnerId,
        callId: ctx.callId,
      });
    } else if (operation.lifecycleStatus === "started" || operation.lifecycleStatus === "failed") {
      const bumped = await repository.update(operation.operationId, {
        attempt: (operation.attempt ?? 1) + 1,
        lifecycleStatus: "started",
        leaseToken: lease.leaseToken,
        leaseOwnerId,
        callId: ctx.callId,
        expectedPlanVersion: group.updatedAt,
      });
      if (bumped.ok) operation = bumped.record;
    } else if (
      operation.lifecycleStatus === "invoice_sent" &&
      operation.invoiceUrl &&
      group.status !== "sent"
    ) {
      // Prior attempt reported delivery — mark local group as sent for consistency.
      invoiceUrl = invoiceUrl ?? operation.invoiceUrl;
      draftOrderId = draftOrderId ?? operation.shopifyDraftOrderId;
      markGroupSent(session, checkoutGroupId);
    }
    if (operation.shopifyDraftOrderId && !draftOrderId) {
      draftOrderId = operation.shopifyDraftOrderId;
    }
    if (operation.invoiceUrl && !invoiceUrl) {
      invoiceUrl = operation.invoiceUrl;
    }

    try {
      renewFlowMutex(session, lease.leaseToken);
      if (!invoiceUrl || (!isEmailRetry && (group.status === "planned" || group.status === "ready"))) {
        // Skip external draft call when a prior attempt already produced one.
        if (operation.shopifyDraftOrderId && operation.invoiceUrl) {
          draftOrderId = operation.shopifyDraftOrderId;
          invoiceUrl = operation.invoiceUrl;
          markGroupDraftCreated(session, checkoutGroupId, draftOrderId, invoiceUrl);
        } else {
        const draft = await createShopifyDraftOrder(
          resolved.items.map((line) => ({
            quantity: line.quantity,
            variantId: line.variantId.startsWith("custom:") ? undefined : line.variantId,
            title: line.title,
            originalUnitPrice: line.unitPrice ?? line.price,
          })),
          confirmed.address,
          (input.customerName ?? "").trim(),
          session.callSid,
        );
        if (!draft.success || !draft.invoiceUrl) {
          await repository.update(operation.operationId, {
            lifecycleStatus: "failed",
            invoiceLastError: draft.error ?? draft.message ?? "draft_failed",
            lastErrorCode: "DRAFT_ORDER_FAILED",
          });
          recordFailureState(
            session,
            "DRAFT_ORDER_FAILED",
            draft.error ?? draft.message ?? "Could not create checkout link.",
          );
          return {
            ok: false,
            checkoutGroupId,
            idempotencyKey: group.idempotencyKey,
            status: group.status,
            failureState: "DRAFT_ORDER_FAILED",
            message: draft.error ?? draft.message ?? "Could not create checkout link.",
          };
        }
        invoiceUrl = draft.invoiceUrl;
        draftOrderId = draft.draftOrderName;
        const draftUpdate = await repository.update(operation.operationId, {
          lifecycleStatus: "draft_created",
          shopifyDraftOrderId: draftOrderId ?? undefined,
          invoiceUrl,
          shopifyInvoiceReference: invoiceUrl,
        });
        if (draftUpdate.ok) operation = draftUpdate.record;
        markGroupDraftCreated(session, checkoutGroupId, draftOrderId ?? "", invoiceUrl);
        }
      }

      // Skip re-send when a prior attempt already committed invoice_sent.
      const alreadyDelivered = operation.lifecycleStatus === "invoice_sent";
      const emailResult = alreadyDelivered
        ? { ok: true as const, messageId: operation.invoiceMessageId }
        : await sendCheckoutEmail(
            confirmed.address,
            (input.customerName ?? "").trim(),
            invoiceUrl!,
            resolved.items,
          );
      assertLeaseValid(session, lease.leaseToken);

      if (!emailResult.ok) {
        await repository.update(operation.operationId, {
          lifecycleStatus: "failed",
          invoiceLastError: emailResult.error ?? "email_send_failed",
          lastErrorCode: "EMAIL_SEND_FAILED",
        });
        markGroupEmailFailed(
          session,
          checkoutGroupId,
          "EMAIL_SEND_FAILED",
          emailResult.error ?? "Could not send checkout email.",
        );
        // Clear global pendingInvoiceUrl lock — group retains recoverable invoiceUrl.
        session.pendingInvoiceUrl = undefined;
        session.pendingDraftOrderName = undefined;
        recordFailureState(
          session,
          "EMAIL_SEND_FAILED",
          emailResult.error ?? "Could not send checkout email.",
          "execute_checkout_group",
        );
        logAction(ctx, "execute_checkout_group", "error", { failureState: "EMAIL_SEND_FAILED" });
        return {
          ok: false,
          checkoutGroupId,
          idempotencyKey: group.idempotencyKey,
          status: "email_failed",
          invoiceUrl,
          draftOrderId,
          failureState: "EMAIL_SEND_FAILED",
          message: emailResult.error ?? "Could not send checkout email.",
        };
      }

      await repository.update(operation.operationId, {
        lifecycleStatus: "invoice_sent",
        invoiceMessageId: "messageId" in emailResult ? emailResult.messageId : undefined,
        shopifyInvoiceReference: invoiceUrl,
        completedAt: Date.now(),
      });
      markGroupSent(session, checkoutGroupId);
      clearFailureState(session);

      const isSubset = resolved.isSubset;
      if (isSubset) {
        deductCheckedOutItems(session, resolved.items);
        resetEmailConfirmation(session);
        const { recordCompletedCheckoutBatch, startMultiBatchCheckout } = await import(
          "../agents/paymentCheckoutFlow.js"
        );
        if (!session.paymentCheckout?.checkoutSession?.active) {
          startMultiBatchCheckout(session);
        }
        recordCompletedCheckoutBatch(
          session,
          confirmed.address,
          resolved.items,
          invoiceUrl!,
        );
      } else {
        session.shoppingCart = [];
        session.currentSessionCart = {};
        session.paymentLinkSent = true;
        session.paymentLinkSentTo = confirmed.address;
      }

      const remaining = getCartSummary(session);
      if (remaining.isEmpty) {
        session.paymentLinkSent = true;
        session.paymentLinkSentTo = confirmed.address;
        const { teardownSession } = await import("../agents/sessionTeardown.js");
        teardownSession(session, {
          reason: "payment_link_transaction_complete",
          preservePaymentSentFlags: true,
        });
      } else {
        session.pendingInvoiceUrl = undefined;
        session.pendingDraftOrderName = undefined;
      }

      logAction(ctx, "execute_checkout_group", "ok", { invoiceUrl, remaining: remaining.totalUnits });
      return {
        ok: true,
        checkoutGroupId,
        idempotencyKey: group.idempotencyKey,
        status: "sent",
        invoiceUrl,
        draftOrderId,
        message: "Your payment link has been sent successfully. Please check your inbox.",
        remainingUnits: remaining.totalUnits,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const timeoutLike = /\b(timeout|timed?\s*out|abort(?:ed)?|network|socket)\b/i.test(reason);
      if (timeoutLike && invoiceUrl) {
        await repository.update(operation.operationId, {
          lifecycleStatus: "invoice_unknown",
          invoiceLastError: reason,
          lastErrorCode: "EMAIL_DELIVERY_UNKNOWN",
        });
        markGroupEmailUnknown(session, checkoutGroupId, "EMAIL_DELIVERY_UNKNOWN", reason);
      } else {
        await repository.update(operation.operationId, {
          lifecycleStatus: "failed",
          invoiceLastError: reason,
          lastErrorCode: "CHECKOUT_EXCEPTION",
        });
        markGroupEmailFailed(session, checkoutGroupId, "CHECKOUT_EXCEPTION", reason);
      }
      session.pendingInvoiceUrl = undefined;
      session.pendingDraftOrderName = undefined;
      recordFailureState(session, "CHECKOUT_EXCEPTION", reason, "execute_checkout_group");
      logAction(ctx, "execute_checkout_group", "error", { reason });
      return {
        ok: false,
        checkoutGroupId,
        idempotencyKey: group.idempotencyKey,
        status: timeoutLike && invoiceUrl ? "email_unknown" : "email_failed",
        invoiceUrl,
        draftOrderId,
        failureState: "CHECKOUT_EXCEPTION",
        message: `Could not create checkout link. ${reason}`.trim(),
      };
    }
  });
}

export const EMAIL_UNKNOWN_PENDING_SPEECH =
  "I've checked the status and the invoice is still pending. I can send it again if you'd like.";

export const EMAIL_UNKNOWN_NEED_RESEND_SPEECH =
  "I've checked the status and we still need to finish sending your payment link. I can try again if you'd like — just say send it again.";

/**
 * Background verification for checkout groups stuck in email_unknown.
 * If a draft/invoice already exists, do NOT force the caller to re-plan the cart —
 * offer a clear resend path instead.
 */
export async function reconcileEmailUnknownGroups(
  session: CallSession,
  ctx: ActionContext,
): Promise<{
  found: boolean;
  checkoutGroupId?: string;
  invoicePending: boolean;
  canResend: boolean;
  speech?: string;
}> {
  const plan = ensureCheckoutPlan(session);
  const unknown = plan.groups.find((g) => g.status === "email_unknown");
  if (!unknown) {
    return { found: false, invoicePending: false, canResend: false };
  }

  logAction(ctx, "reconcile_email_unknown", "start", {
    checkoutGroupId: unknown.checkoutGroupId,
  });

  // Prefer live group (plan may be stale mid-turn).
  const group = getCheckoutGroup(session, unknown.checkoutGroupId) ?? unknown;
  const invoicePending = Boolean(group.invoiceUrl || group.draftOrderId);

  const memory = (await import("../agents/sessionMemory.js")).ensureSessionMemory(session);
  memory.emailUnknownReconcile = {
    checkoutGroupId: group.checkoutGroupId,
    invoicePending,
    checkedAt: Date.now(),
  };

  const speech = invoicePending
    ? EMAIL_UNKNOWN_PENDING_SPEECH
    : EMAIL_UNKNOWN_NEED_RESEND_SPEECH;

  logAction(ctx, "reconcile_email_unknown", "ok", {
    checkoutGroupId: group.checkoutGroupId,
    invoicePending,
  });

  return {
    found: true,
    checkoutGroupId: group.checkoutGroupId,
    invoicePending,
    canResend: true,
    speech,
  };
}

export const ActionGateway = {
  executeCheckoutGroup,
  escalateToHuman,
  createSupportCase,
  reconcileEmailUnknownGroups,
} as const;
