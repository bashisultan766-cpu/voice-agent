import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CallSession } from "../src/types/order.js";
import {
  analyzeAndTrackSentiment,
  escalateToHuman,
  isCheckoutBatchMidFlow,
  SENTIMENT_SHIELD_THRESHOLD,
  SENTIMENT_SHIELD_SPEECH,
} from "../src/utils/sentiment.js";
import { applyBrainWorkflowControl } from "../src/agents/agentBrain.js";
import { ensureSessionMemory } from "../src/agents/sessionMemory.js";
import {
  CheckoutManager,
  startMultiBatchCheckout,
  setCurrentCheckoutBatch,
} from "../src/agents/paymentCheckoutFlow.js";
import { ensureShoppingCart } from "../src/agents/cartManager.js";
import { resolveCheckoutLineItems } from "../src/agents/cartManager.js";
import { issueConfirmedEmail } from "../src/agents/emailConfirmationManager.js";
import { cartLinesToGroupLines, getCheckoutGroup, planCheckoutGroup } from "../src/domain/checkoutModels.js";
import { ActionGateway } from "../src/runtime/actionGateway.js";

const { mockCreateDraft, mockSendEmail, mockResendAvailable } = vi.hoisted(() => ({
  mockCreateDraft: vi.fn(),
  mockSendEmail: vi.fn(),
  mockResendAvailable: vi.fn(() => true),
}));

vi.mock("../src/adapters/shopifyStorefrontAdapter.js", () => ({
  createShopifyDraftOrder: mockCreateDraft,
}));

vi.mock("../src/utils/resendEmailService.js", () => ({
  isResendAvailable: mockResendAvailable,
  isValidCustomerEmail: (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
  sendCheckoutEmail: mockSendEmail,
}));

async function executeCheckoutGroupViaGateway(
  session: CallSession,
  email: string,
  options: { customerName?: string; items?: Array<{ title?: string; quantity: number }> },
) {
  const resolved = resolveCheckoutLineItems(session, options.items);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  const existingId = ensureSessionMemory(session).latestCheckoutGroupId;
  const planned = existingId ? null : planCheckoutGroup(session, cartLinesToGroupLines(resolved.items));
  if (planned && !planned.ok) return { ok: false, message: planned.message };
  const checkoutGroupId = existingId ?? planned!.group.checkoutGroupId;
  ensureSessionMemory(session).latestCheckoutGroupId = checkoutGroupId;
  const prior = getCheckoutGroup(session, checkoutGroupId)?.confirmedEmailId;
  const confirmed = prior
    ? { confirmedEmailId: prior }
    : issueConfirmedEmail(session, email, "payment_link");
  const result = await ActionGateway.executeCheckoutGroup(
    { session, checkoutGroupId, confirmedEmailId: confirmed.confirmedEmailId, customerName: options.customerName },
    { callId: session.callSid, actionId: "test_checkout" },
  );
  return { ...result, splitBatch: resolved.isSubset };
}

function makeSession(callSid = "CA_SENT"): CallSession {
  return {
    callSid,
    from: "+1",
    to: "+2",
    phase: "follow_up",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
  } as CallSession;
}

describe("Sentiment Shield", () => {
  it("Unit Test 1 — 'What is this?' three times arms escalate_to_human", () => {
    const session = makeSession("CA_FRUST");

    let result = analyzeAndTrackSentiment(session, "What is this?");
    expect(result.frustrationCount).toBe(1);
    expect(result.shieldArmed).toBe(false);

    result = analyzeAndTrackSentiment(session, "What is this?");
    expect(result.frustrationCount).toBe(2);
    expect(result.shieldArmed).toBe(false);

    // Threshold is > 2, so third hit arms the shield
    result = analyzeAndTrackSentiment(session, "What is this?");
    expect(result.frustrationCount).toBeGreaterThan(SENTIMENT_SHIELD_THRESHOLD);
    expect(result.shieldArmed).toBe(true);

    const ticket = escalateToHuman(session, "sentiment_shield");
    expect(ticket.recommendEscalation).toBe(true);
    expect(ticket.ticketIdPreview).toMatch(/^HUM-/);
    expect(ensureSessionMemory(session).humanEscalationTriggered).not.toBe(true);

    const brain = applyBrainWorkflowControl(session, "this is useless", "general_help");
    expect(brain.sentimentShieldSpeech).toBe(SENTIMENT_SHIELD_SPEECH);

  });

  it("defers Sentiment Shield while a payment batch is mid-flow", () => {
    const session = makeSession("CA_DEFER");
    session.shoppingCart = [
      {
        variantId: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        title: "Book A",
        quantity: 2,
        unitPrice: "10.00",
      },
    ];
    startMultiBatchCheckout(session);
    setCurrentCheckoutBatch(session, [{ title: "Book A", quantity: 2 }]);
    expect(isCheckoutBatchMidFlow(session)).toBe(true);

    ensureSessionMemory(session).frustrationCount = 2;
    const result = analyzeAndTrackSentiment(session, "What is this?");
    expect(result.frustrationCount).toBe(3);
    expect(result.shieldArmed).toBe(false);
    expect(ensureSessionMemory(session).pendingSentimentShield).toBe(true);
    expect(ensureSessionMemory(session).humanEscalationTriggered).not.toBe(true);
  });
});

describe("Dynamic Payment Orchestrator batching", () => {
  beforeEach(() => {
    mockCreateDraft.mockReset();
    mockSendEmail.mockReset();
    mockResendAvailable.mockReturnValue(true);
    mockCreateDraft.mockResolvedValue({
      success: true,
      invoiceUrl: "https://checkout.example/inv",
      draftOrderName: "#D1",
    });
    mockSendEmail.mockResolvedValue({ ok: true });
  });

  it("Unit Test 2 — Cart State only removes items after payment link succeeds", async () => {
    const session = makeSession("CA_BATCH");
    session.shoppingCart = [
      {
        variantId: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        title: "Book A",
        quantity: 2,
        unitPrice: "10.00",
      },
      {
        variantId: "gid://shopify/ProductVariant/2",
        productId: "gid://shopify/Product/2",
        title: "Book B",
        quantity: 3,
        unitPrice: "12.00",
      },
    ];

    startMultiBatchCheckout(session);
    const locked = setCurrentCheckoutBatch(session, [{ title: "Book A", quantity: 2 }]);
    expect(locked.ok).toBe(true);

    // Before payment tool: cart unchanged; confirmed_batch held as temporary state.
    expect(ensureShoppingCart(session)).toHaveLength(2);
    const before = CheckoutManager.getProcessedVsCart(session);
    expect(before.cart_items.reduce((s, l) => s + l.quantity, 0)).toBe(5);
    expect(before.processed_items).toHaveLength(0);
    expect(before.confirmed_batch?.items).toHaveLength(1);

    // Failed send must not deduct cart.
    mockSendEmail.mockResolvedValueOnce({ ok: false, error: "smtp down" });
    const failed = await executeCheckoutGroupViaGateway(session, "a@example.com", {
      customerName: "Caller",
      items: [{ title: "Book A", quantity: 2 }],
    });
    expect(failed.ok).toBe(false);
    expect(ensureShoppingCart(session)).toHaveLength(2);

    mockSendEmail.mockResolvedValue({ ok: true });
    const ok = await executeCheckoutGroupViaGateway(session, "a@example.com", {
      customerName: "Caller",
      items: [{ title: "Book A", quantity: 2 }],
    });
    expect(ok.ok).toBe(true);
    expect(ok.splitBatch).toBe(true);

    // After success: Book A removed; Book B remains; processed_items updated.
    const cart = ensureShoppingCart(session);
    expect(cart).toHaveLength(1);
    expect(cart[0]?.title).toBe("Book B");
    const after = CheckoutManager.getProcessedVsCart(session);
    expect(after.processed_items.reduce((s, l) => s + l.quantity, 0)).toBe(2);
    expect(after.cart_items.reduce((s, l) => s + l.quantity, 0)).toBe(3);
  });
});
