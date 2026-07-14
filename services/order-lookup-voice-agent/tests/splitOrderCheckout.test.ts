import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CallSession } from "../src/types/order.js";
import {
  resolveCheckoutLineItems,
  deductCheckedOutItems,
  ensureShoppingCart,
} from "../src/agents/cartManager.js";
import {
  startMultiBatchCheckout,
  getCheckoutSession,
  setCurrentCheckoutBatch,
  remainingUnits,
  buildPostBatchRemainingSpeech,
  initiateCheckoutBatch,
  getCartIterator,
  CheckoutManager,
} from "../src/agents/paymentCheckoutFlow.js";
import { SHOSHAN_SYSTEM_PROMPT } from "../src/prompts/systemPrompt.js";
import { issueConfirmedEmail } from "../src/agents/emailConfirmationManager.js";
import { planCheckoutGroup, cartLinesToGroupLines } from "../src/domain/checkoutModels.js";
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
  options: { customerName?: string; items?: Array<{ title?: string; position?: number; quantity: number }> },
) {
  const resolved = resolveCheckoutLineItems(session, options.items);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  const planned = planCheckoutGroup(session, cartLinesToGroupLines(resolved.items));
  if (!planned.ok) return { ok: false, message: planned.message };
  const confirmed = issueConfirmedEmail(session, email, "payment_link");
  const result = await ActionGateway.executeCheckoutGroup(
    { session, checkoutGroupId: planned.group.checkoutGroupId, confirmedEmailId: confirmed.confirmedEmailId, customerName: options.customerName },
    { callId: session.callSid, actionId: "test_checkout" },
  );
  return { ...result, splitBatch: resolved.isSubset, remainingCartUnits: result.remainingUnits };
}

function sessionWithSixUnits(callSid: string): CallSession {
  return {
    callSid,
    from: "+1",
    to: "+2",
    phase: "cart_active",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    shoppingCart: [
      {
        variantId: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        title: "Book A",
        quantity: 2,
        unitPrice: "10.00",
        price: "10.00",
      },
      {
        variantId: "gid://shopify/ProductVariant/2",
        productId: "gid://shopify/Product/2",
        title: "Book B",
        quantity: 3,
        unitPrice: "12.00",
        price: "12.00",
      },
      {
        variantId: "gid://shopify/ProductVariant/3",
        productId: "gid://shopify/Product/3",
        title: "Book C",
        quantity: 1,
        unitPrice: "8.00",
        price: "8.00",
      },
    ],
  } as CallSession;
}

describe("split-order / multi-batch checkout", () => {
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

  it("system prompt includes MULTI-BATCH PAYMENT ORCHESTRATOR", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/MULTI-BATCH PAYMENT ORCHESTRATOR/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /Let's do this one step at a time so nothing gets mixed up/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NEVER collect all emails at once/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/which email for the remaining \[Y\] books|Shall we proceed with the remaining/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/SEMANTIC SLOT|CONTEXTUAL REPAIR/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/initiate_checkout_batch/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CartIterator/i);
  });

  it("resolves a subset of cart lines without touching the rest", () => {
    const session = sessionWithSixUnits("CA_SPLIT_RESOLVE");
    const resolved = resolveCheckoutLineItems(session, [
      { title: "Book A", quantity: 2 },
      { variant_id: "gid://shopify/ProductVariant/2", quantity: 1 },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.isSubset).toBe(true);
    expect(resolved.items).toHaveLength(2);
    expect(resolved.items[0]?.title).toBe("Book A");
    expect(resolved.items[0]?.quantity).toBe(2);
    expect(resolved.items[1]?.quantity).toBe(1);
    expect(ensureShoppingCart(session)).toHaveLength(3);
  });

  it("resolves books by 1-based cart position", () => {
    const session = sessionWithSixUnits("CA_SPLIT_POS");
    const resolved = resolveCheckoutLineItems(session, [
      { position: 1, quantity: 2 },
      { position: 2, quantity: 3 },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.items.map((line) => line.title)).toEqual(["Book A", "Book B"]);
  });

  it("deducts only checked-out quantities from the cart", () => {
    const session = sessionWithSixUnits("CA_SPLIT_DEDCT");
    deductCheckedOutItems(session, [
      {
        variantId: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        title: "Book A",
        quantity: 2,
      },
    ]);
    const cart = ensureShoppingCart(session);
    expect(cart.find((line) => line.title === "Book A")).toBeUndefined();
    expect(cart).toHaveLength(2);
  });

  it("CheckoutSession tracks 2 → 3 → 1 across three emails", async () => {
    const session = sessionWithSixUnits("CA_SPLIT_FSM");
    const started = startMultiBatchCheckout(session);
    expect(started.phase).toBe("selecting_batch");
    expect(remainingUnits(session)).toBe(6);
    expect(started.completedBatches).toHaveLength(0);

    const batch1 = setCurrentCheckoutBatch(session, [{ title: "Book A", quantity: 2 }]);
    expect(batch1.ok).toBe(true);
    expect(getCheckoutSession(session)?.phase).toBe("awaiting_batch_email");

    const first = await executeCheckoutGroupViaGateway(session, "a@example.com", {
      customerName: "Caller",
      items: [{ title: "Book A", quantity: 2 }],
      skipConfirmedEmailGate: true,
    });
    expect(first.ok).toBe(true);
    expect(first.splitBatch).toBe(true);
    expect(first.remainingCartUnits).toBe(4);
    expect(getCheckoutSession(session)?.completedBatches).toHaveLength(1);
    expect(getCheckoutSession(session)?.phase).toBe("confirming_continue");
    expect(buildPostBatchRemainingSpeech(session, "a@example.com")).toMatch(
      /Shall we proceed with the remaining 4 items/i,
    );
    expect(session.paymentLinkSent).not.toBe(true);

    const second = await executeCheckoutGroupViaGateway(session, "b@example.com", {
      customerName: "Caller",
      items: [{ title: "Book B", quantity: 3 }],
      skipConfirmedEmailGate: true,
    });
    expect(second.ok).toBe(true);
    expect(second.remainingCartUnits).toBe(1);
    expect(getCheckoutSession(session)?.completedBatches).toHaveLength(2);
    expect(getCheckoutSession(session)?.remainingItems).toEqual([
      { variantId: "gid://shopify/ProductVariant/3", title: "Book C", quantity: 1 },
    ]);

    const third = await executeCheckoutGroupViaGateway(session, "c@example.com", {
      customerName: "Caller",
      items: [{ position: 1, quantity: 1 }],
      skipConfirmedEmailGate: true,
    });
    expect(third.ok).toBe(true);
    expect(third.remainingCartUnits).toBe(0);
    expect(session.paymentLinkSent).toBe(true);
    expect(getCheckoutSession(session)?.phase).toBe("completed");
    expect(getCheckoutSession(session)?.active).toBe(false);
    expect(getCheckoutSession(session)?.completedBatches).toHaveLength(3);
    expect(getCheckoutSession(session)?.completedBatches.map((b) => b.email)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    expect(mockCreateDraft).toHaveBeenCalledTimes(3);
  });

  it("initiate_checkout_batch locks pending batch without deducting CartState", () => {
    const session = sessionWithSixUnits("CA_INIT_BATCH");
    const result = initiateCheckoutBatch(session, [{ title: "Book A", quantity: 2 }], {
      startEmailCapture: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batch).toEqual([
      { variantId: "gid://shopify/ProductVariant/1", title: "Book A", quantity: 2 },
    ]);
    expect(getCheckoutSession(session)?.phase).toBe("awaiting_batch_email");
    expect(getCartIterator(session).reduce((s, l) => s + l.quantity, 0)).toBe(6);
    expect(session.shoppingCart).toHaveLength(3);
    expect(CheckoutManager.getCartState(session).totalUnits).toBe(6);
  });
});
