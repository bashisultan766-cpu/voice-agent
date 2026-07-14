/**
 * Crash/restart tests for the durable CheckoutOperation lifecycle.
 *
 * We simulate process restart by rebinding the module-scope default repository
 * with the SAME underlying Map, then invoking ActionGateway.executeCheckoutGroup
 * again. The stateful mocks (draft order + email) count invocations so we can
 * assert no duplicate Shopify draft is created and no duplicate invoice email
 * is sent on the second attempt.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallSession } from "../src/types/order.js";
import {
  InMemoryCheckoutOperationRepository,
  type CheckoutOperationRecord,
} from "../src/domain/checkoutOperation.js";
import { planCheckoutGroup, cartLinesToGroupLines } from "../src/domain/checkoutModels.js";
import { issueConfirmedEmail } from "../src/agents/emailConfirmationManager.js";

const { mockCreateDraft, mockSendEmail } = vi.hoisted(() => ({
  mockCreateDraft: vi.fn(),
  mockSendEmail: vi.fn(),
}));

vi.mock("../src/infra/shopifyDraftOrderClient.js", () => ({
  createShopifyDraftOrder: mockCreateDraft,
}));

vi.mock("../src/infra/checkoutInvoiceEmailClient.js", () => ({
  sendCheckoutEmail: mockSendEmail,
}));

vi.mock("../src/utils/emailDeliveryConfig.js", () => ({
  isEmailDeliveryConfigured: () => true,
}));

import { ActionGateway } from "../src/runtime/actionGateway.js";

function baseSession(callSid: string): CallSession {
  return {
    callSid,
    from: "+15551234567",
    to: "+15550000000",
    phase: "cart_active",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    shoppingCart: [
      {
        variantId: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        title: "Book A",
        quantity: 1,
        unitPrice: "10.00",
      },
    ],
  } as CallSession;
}

function planGroup(session: CallSession) {
  const lines = cartLinesToGroupLines(session.shoppingCart!);
  const planned = planCheckoutGroup(session, lines);
  if (!planned.ok) throw new Error(`plan failed: ${planned.message}`);
  const confirmed = issueConfirmedEmail(session, "buyer@example.com", "payment_link");
  return { checkoutGroupId: planned.group.checkoutGroupId, confirmedEmailId: confirmed.confirmedEmailId };
}

describe("checkout operation crash/restart", () => {
  beforeEach(() => {
    mockCreateDraft.mockReset();
    mockSendEmail.mockReset();
  });

  it("second attempt after successful invoice_sent does not resend or recreate draft", async () => {
    const store = new Map<string, CheckoutOperationRecord>();
    const repo = new InMemoryCheckoutOperationRepository(store);
    mockCreateDraft.mockResolvedValue({
      success: true,
      invoiceUrl: "https://checkout.example/inv",
      draftOrderName: "#D1",
    });
    mockSendEmail.mockResolvedValue({ ok: true, messageId: "msg_1" });

    const session = baseSession("CA_CRASH_OK");
    const { checkoutGroupId, confirmedEmailId } = planGroup(session);
    const first = await ActionGateway.executeCheckoutGroup(
      { session, checkoutGroupId, confirmedEmailId, checkoutOperationRepository: repo },
      { callId: session.callSid, actionId: "act_1", idempotencyKey: "idem_1" },
    );
    expect(first.ok).toBe(true);
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);

    // Simulate restart: rebind repo to same store; keep session state.
    const rebooted = new InMemoryCheckoutOperationRepository(store);
    const persisted = await rebooted.list();
    expect(persisted[0]?.lifecycleStatus).toBe("invoice_sent");

    const second = await ActionGateway.executeCheckoutGroup(
      { session, checkoutGroupId, confirmedEmailId, checkoutOperationRepository: rebooted },
      { callId: session.callSid, actionId: "act_2", idempotencyKey: "idem_1" },
    );
    expect(second.ok).toBe(true);
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("crash after draft_created before invoice_sent → second attempt sends invoice without new draft", async () => {
    const store = new Map<string, CheckoutOperationRecord>();
    const repo = new InMemoryCheckoutOperationRepository(store);
    mockCreateDraft.mockResolvedValueOnce({
      success: true,
      invoiceUrl: "https://checkout.example/inv",
      draftOrderName: "#D2",
    });
    mockSendEmail.mockRejectedValueOnce(new Error("network timeout"));

    const session = baseSession("CA_CRASH_DRAFT");
    const { checkoutGroupId, confirmedEmailId } = planGroup(session);
    const first = await ActionGateway.executeCheckoutGroup(
      { session, checkoutGroupId, confirmedEmailId, checkoutOperationRepository: repo },
      { callId: session.callSid, actionId: "a1", idempotencyKey: "idem_draft" },
    );
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);

    const persisted = await repo.list();
    expect(persisted[0]?.shopifyDraftOrderId).toBe("#D2");
    expect(persisted[0]?.invoiceUrl).toBeDefined();

    // Restart: reuse store, retry.
    const rebooted = new InMemoryCheckoutOperationRepository(store);
    mockSendEmail.mockResolvedValueOnce({ ok: true, messageId: "msg_retry" });
    const second = await ActionGateway.executeCheckoutGroup(
      { session, checkoutGroupId, confirmedEmailId, checkoutOperationRepository: rebooted },
      { callId: session.callSid, actionId: "a2", idempotencyKey: "idem_draft" },
    );
    expect(second.ok).toBe(true);
    expect(mockCreateDraft).toHaveBeenCalledTimes(1); // never a second draft
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });

  it("email timeout marks invoice_unknown; retry with same idempotencyKey re-sends without new draft", async () => {
    const store = new Map<string, CheckoutOperationRecord>();
    const repo = new InMemoryCheckoutOperationRepository(store);
    mockCreateDraft.mockResolvedValueOnce({
      success: true,
      invoiceUrl: "https://checkout.example/inv-unk",
      draftOrderName: "#DU",
    });
    // Path A of ActionGateway: rejection triggers the timeout branch which marks invoice_unknown.
    mockSendEmail.mockRejectedValueOnce(new Error("Socket timeout"));

    const session = baseSession("CA_CRASH_UNK");
    const { checkoutGroupId, confirmedEmailId } = planGroup(session);
    const first = await ActionGateway.executeCheckoutGroup(
      { session, checkoutGroupId, confirmedEmailId, checkoutOperationRepository: repo },
      { callId: session.callSid, actionId: "u1", idempotencyKey: "idem_unk" },
    );
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.status).toBe("email_unknown");

    const rebooted = new InMemoryCheckoutOperationRepository(store);
    const priorRecord = (await rebooted.list())[0];
    expect(priorRecord?.lifecycleStatus).toBe("invoice_unknown");

    mockSendEmail.mockResolvedValueOnce({ ok: true, messageId: "msg_final" });
    const second = await ActionGateway.executeCheckoutGroup(
      { session, checkoutGroupId, confirmedEmailId, checkoutOperationRepository: rebooted },
      { callId: session.callSid, actionId: "u2", idempotencyKey: "idem_unk" },
    );
    // Second attempt should succeed without re-creating the draft.
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    expect(second.ok).toBe(true);
  });

  it("concurrent workers with same idempotencyKey converge on a single durable record", async () => {
    const store = new Map<string, CheckoutOperationRecord>();
    const repo = new InMemoryCheckoutOperationRepository(store);
    mockCreateDraft.mockResolvedValue({
      success: true,
      invoiceUrl: "https://checkout.example/inv-race",
      draftOrderName: "#DR",
    });
    mockSendEmail.mockResolvedValue({ ok: true, messageId: "msg_race" });

    const session = baseSession("CA_CRASH_RACE");
    const { checkoutGroupId, confirmedEmailId } = planGroup(session);
    const [a, b] = await Promise.all([
      ActionGateway.executeCheckoutGroup(
        { session, checkoutGroupId, confirmedEmailId, checkoutOperationRepository: repo },
        { callId: session.callSid, actionId: "r1", idempotencyKey: "idem_race" },
      ),
      ActionGateway.executeCheckoutGroup(
        { session, checkoutGroupId, confirmedEmailId, checkoutOperationRepository: repo },
        { callId: session.callSid, actionId: "r2", idempotencyKey: "idem_race" },
      ),
    ]);
    expect(a.ok || b.ok).toBe(true);
    // The durable log must never fork — one idempotencyKey ⇒ one record.
    const records = await repo.list();
    expect(records.length).toBe(1);
    expect(records[0]?.idempotencyKey).toBe("idem_race");
  });

  it("stale-plan writer cannot commit invoice_sent after plan bumped", async () => {
    const store = new Map<string, CheckoutOperationRecord>();
    const repo = new InMemoryCheckoutOperationRepository(store);
    await repo.create({
      operationId: "op_stale",
      idempotencyKey: "idem_stale",
      checkoutPlanId: "plan_1",
      checkoutGroupId: "grp_1",
      attempt: 1,
      lifecycleStatus: "started",
      expectedPlanVersion: 1,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const bumped = await repo.update(
      "op_stale",
      { lifecycleStatus: "invoice_sent" },
      { expectedPlanVersion: 99 },
    );
    expect(bumped.ok).toBe(false);
    if (bumped.ok) return;
    expect(bumped.reason).toBe("stale_plan");
    const record = (await repo.list())[0];
    expect(record?.lifecycleStatus).toBe("started");
  });

  it("restart after STARTED before Shopify request creates exactly one draft", async () => {
    const store = new Map<string, CheckoutOperationRecord>();
    const repo = new InMemoryCheckoutOperationRepository(store);
    const session = baseSession("CA_STARTED_RESTART");
    const { checkoutGroupId, confirmedEmailId } = planGroup(session);
    await repo.create({
      operationId: "op_started", idempotencyKey: "idem_started", checkoutPlanId: checkoutGroupId,
      checkoutGroupId, attempt: 1, lifecycleStatus: "started", expectedPlanVersion: 0,
      startedAt: Date.now(), updatedAt: Date.now(),
    });
    mockCreateDraft.mockResolvedValue({ success: true, invoiceUrl: "https://checkout.example/started", draftOrderName: "#DS" });
    mockSendEmail.mockResolvedValue({ ok: true, messageId: "msg_started" });
    const result = await ActionGateway.executeCheckoutGroup(
      { session, checkoutGroupId, confirmedEmailId, checkoutOperationRepository: new InMemoryCheckoutOperationRepository(store) },
      { callId: session.callSid, actionId: "started_restart", idempotencyKey: "idem_started" },
    );
    expect(result.ok).toBe(true);
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
  });

  it("pre-seeded draft operation reconciles after crash before local group commit", async () => {
    const store = new Map<string, CheckoutOperationRecord>();
    const repo = new InMemoryCheckoutOperationRepository(store);
    const session = baseSession("CA_DRAFT_RECONCILE");
    const { checkoutGroupId, confirmedEmailId } = planGroup(session);
    await repo.create({
      operationId: "op_draft", idempotencyKey: "idem_draft_reconcile", checkoutPlanId: checkoutGroupId,
      checkoutGroupId, attempt: 1, lifecycleStatus: "draft_created", shopifyDraftOrderId: "#D_PRE",
      invoiceUrl: "https://checkout.example/pre", expectedPlanVersion: 0, startedAt: Date.now(), updatedAt: Date.now(),
    });
    mockSendEmail.mockResolvedValue({ ok: true, messageId: "msg_pre" });
    const result = await ActionGateway.executeCheckoutGroup(
      { session, checkoutGroupId, confirmedEmailId, checkoutOperationRepository: new InMemoryCheckoutOperationRepository(store) },
      { callId: session.callSid, actionId: "draft_reconcile", idempotencyKey: "idem_draft_reconcile" },
    );
    expect(result.ok).toBe(true);
    expect(mockCreateDraft).not.toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("restart reconciles already-sent operation without provider calls", async () => {
    const store = new Map<string, CheckoutOperationRecord>();
    const repo = new InMemoryCheckoutOperationRepository(store);
    const session = baseSession("CA_SENT_RECONCILE");
    const { checkoutGroupId, confirmedEmailId } = planGroup(session);
    await repo.create({
      operationId: "op_sent", idempotencyKey: "idem_sent_reconcile", checkoutPlanId: checkoutGroupId,
      checkoutGroupId, attempt: 1, lifecycleStatus: "invoice_sent", shopifyDraftOrderId: "#D_SENT",
      invoiceUrl: "https://checkout.example/sent", invoiceMessageId: "msg_sent",
      expectedPlanVersion: 0, startedAt: Date.now(), updatedAt: Date.now(), completedAt: Date.now(),
    });
    const result = await ActionGateway.executeCheckoutGroup(
      { session, checkoutGroupId, confirmedEmailId, checkoutOperationRepository: new InMemoryCheckoutOperationRepository(store) },
      { callId: session.callSid, actionId: "sent_reconcile", idempotencyKey: "idem_sent_reconcile" },
    );
    expect(result.ok).toBe(true);
    expect(mockCreateDraft).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("provider non-timeout failure remains recoverable email_failed", async () => {
    const store = new Map<string, CheckoutOperationRecord>();
    const repo = new InMemoryCheckoutOperationRepository(store);
    mockCreateDraft.mockResolvedValue({ success: true, invoiceUrl: "https://checkout.example/fail", draftOrderName: "#DF" });
    mockSendEmail.mockResolvedValue({ ok: false, error: "provider rejected recipient" });
    const session = baseSession("CA_PROVIDER_FAIL");
    const { checkoutGroupId, confirmedEmailId } = planGroup(session);
    const result = await ActionGateway.executeCheckoutGroup(
      { session, checkoutGroupId, confirmedEmailId, checkoutOperationRepository: repo },
      { callId: session.callSid, actionId: "provider_fail", idempotencyKey: "idem_provider_fail" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("email_failed");
    expect((await repo.list())[0]?.lifecycleStatus).toBe("failed");
  });

  it("restart reuses a draft after an explicit email failure", async () => {
    const store = new Map<string, CheckoutOperationRecord>();
    const repo = new InMemoryCheckoutOperationRepository(store);
    mockCreateDraft.mockResolvedValue({ success: true, invoiceUrl: "https://checkout.example/retry", draftOrderName: "#D_RETRY" });
    mockSendEmail.mockResolvedValueOnce({ ok: false, error: "provider rejected recipient" });
    const session = baseSession("CA_FAILURE_RESTART");
    const { checkoutGroupId, confirmedEmailId } = planGroup(session);
    await ActionGateway.executeCheckoutGroup(
      { session, checkoutGroupId, confirmedEmailId, checkoutOperationRepository: repo },
      { callId: session.callSid, actionId: "failure_1", idempotencyKey: "idem_failure_restart" },
    );
    mockSendEmail.mockResolvedValueOnce({ ok: true, messageId: "msg_retry_after_failure" });
    const retry = await ActionGateway.executeCheckoutGroup(
      { session, checkoutGroupId, confirmedEmailId, checkoutOperationRepository: new InMemoryCheckoutOperationRepository(store) },
      { callId: session.callSid, actionId: "failure_2", idempotencyKey: "idem_failure_restart" },
    );
    expect(retry.ok).toBe(true);
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
  });
});
