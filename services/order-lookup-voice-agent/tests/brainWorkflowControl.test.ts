import { beforeEach, describe, expect, it } from "vitest";
import { createCallSession } from "../src/agents/orderAgent.js";
import {
  applyBrainWorkflowControl,
  isWorkflowCancellationUtterance,
  resolveAgentWorkflow,
  shouldSuppressCatalogEscalation,
  shouldSuppressSupportEscalation,
  tryDeterministicCartTurn,
} from "../src/agents/agentBrain.js";
import { recordLastCatalogSearch } from "../src/agents/catalogTarget.js";
import { resolveCallerIntent } from "../src/agents/callerIntent.js";
import {
  clearAllConversationFlowModes,
  setConversationFlowMode,
} from "../src/agents/conversationFlowState.js";
import { getSessionMemory } from "../src/agents/sessionMemory.js";
import {
  armPrivateInfoBlockedEscalation,
  cancelSupportEscalation,
  getSupportEscalationState,
  isSupportEscalationActive,
} from "../src/agents/supportEscalationFlow.js";
import { applyCallerVerificationFromOrder } from "../src/agents/callerVerification.js";
import { filterOrderContextForVerification } from "../src/agents/orderContextPrivacy.js";
import { buildOrderDetailSpeech } from "../src/agents/orderDetailBuilder.js";
import { toolResultForLlm } from "../src/adapters/llmToolExecutor.js";
import { isCartActionUtterance, parseCartQuantityFromSpeech } from "../src/agents/catalogShoppingIntent.js";
import type { CallSession } from "../src/types/order.js";

const ORDER_CONTEXT = {
  order_number: "48065",
  customer_name: "Frederick Marcalus",
  shipping_address: "123 Main St",
  physical_items: [{ title: "Healing Book", quantity: 1, price: "$12.00 USD" }],
  shipping_amount: "$5.00 USD",
  total_amount: "$17.00 USD",
  payment_method: "Visa ending in 4242",
  payment_gateway: "shopify_payments",
  payment_method_last4: "4242",
  card_brand: "Visa",
  order_confirmation_email: "fred@example.com",
  events: ["Order confirmation email was sent to fred@example.com"],
};

function seedSession(callSid: string, verified: boolean): CallSession {
  const phone = verified ? "+15551234567" : "+15550001111";
  const session = createCallSession(callSid, phone, "+18005551212");
  session.orderContextConfirmed = true;
  session.currentOrderData = { ...ORDER_CONTEXT };
  applyCallerVerificationFromOrder(session, {
    status: "found",
    orderNumber: "48065",
    customerName: "Frederick Marcalus",
    customerPhone: "+15551234567",
    customerId: "gid://shopify/Customer/1",
    totalOrderCount: 3,
  } as any);
  if (!verified) session.isVerifiedCaller = false;
  return session;
}

function seedProductSession(callSid: string): CallSession {
  const session = createCallSession(callSid, "+15550001", "+1800555");
  recordLastCatalogSearch(session, {
    status: "found",
    bookName: "Playbook Football Guide",
    variantId: "gid://shopify/ProductVariant/999",
    price: "19.99",
    inStock: true,
  });
  setConversationFlowMode(callSid, "PURCHASE_FLOW");
  session.lastOrchestratorIntent = "catalog";
  return session;
}

describe("brain workflow control — product and cart", () => {
  beforeEach(() => clearAllConversationFlowModes());

  it("1-4 — add 20 copies of last found product without support escalation", () => {
    const session = seedProductSession("BW_1");
    expect(resolveCallerIntent("Add 20 copies", session)).toBe("cart");
    const cart = tryDeterministicCartTurn(session, "Add 20 copies");
    expect(cart?.speech).toMatch(/20 copies of Playbook Football Guide/i);
    expect(session.shoppingCart?.[0]?.quantity).toBe(20);
    expect(isSupportEscalationActive(session)).toBe(false);
  });

  it("5 — does not trigger support on cart quantity", () => {
    const session = seedProductSession("BW_2");
    expect(shouldSuppressSupportEscalation(session, "Add 20 copies", "cart")).toBe(true);
  });

  it("6-8 — cancels support escalation and adds to cart", () => {
    const session = seedProductSession("BW_3");
    armPrivateInfoBlockedEscalation(session, "shipping address", "test");
    expect(getSupportEscalationState(session)).toBe("non_verified_private_info_blocked");

    const brain = applyBrainWorkflowControl(
      session,
      "No, don't send to support. Add 20 copies",
      "cart",
    );
    expect(brain.cancelledSupport).toBe(true);
    expect(getSupportEscalationState(session)).toBe("normal");
    expect(brain.deterministicCartSpeech).toMatch(/20 copies/i);
    expect(session.shoppingCart?.[0]?.quantity).toBe(20);
  });

  it("9-10 — ISBN in product context routes to catalog", () => {
    const session = seedProductSession("BW_4");
    expect(resolveCallerIntent("9780143127550", session)).toBe("catalog");
  });

  it("11-12 — order number in order context routes to order lookup", () => {
    const session = createCallSession("BW_5", "+1", "+1");
    session.phase = "awaiting_order_number";
    session.awaitingInput = "order_number";
    expect(resolveCallerIntent("check my order", session)).toBe("order_lookup");
    expect(resolveCallerIntent("48065", session)).not.toBe("catalog");
  });
});

describe("brain session memory", () => {
  it("13-16 — remembers product, quantity, workflow, verification", () => {
    const session = seedProductSession("BM_1");
    const brain = applyBrainWorkflowControl(session, "Add 20 copies", "cart");
    const memory = getSessionMemory(session);
    expect(memory.lastProductTitle).toMatch(/Playbook Football Guide/i);
    expect(memory.latestQuantityRequested).toBe(20);
    expect(brain.activeWorkflow).toBe("cart_checkout");
    expect(memory.verificationStatus).toBe("non_verified");
  });
});

describe("support escalation override", () => {
  it("17-20 — refuses address, cancels on buy intent", () => {
    const session = seedSession("SE_1", false);
    armPrivateInfoBlockedEscalation(session, "shipping address", "test");
    const refusal = buildOrderDetailSpeech(
      session,
      "what is the shipping address",
      filterOrderContextForVerification(session.currentOrderData as any, false),
    );
    expect(refusal).toMatch(/cannot provide the shipping address|can't provide the shipping address/i);

    expect(isWorkflowCancellationUtterance("No, I want to buy a book")).toBe(true);
    applyBrainWorkflowControl(session, "No, I want to buy a book", "catalog");
    expect(getSupportEscalationState(session)).toBe("normal");
    cancelSupportEscalation(session);
    expect(isSupportEscalationActive(session)).toBe(false);
  });
});

describe("shopify timeline and payment details", () => {
  it("21-25 — uses real payment/notification fields, no hallucination", () => {
    const session = seedSession("TL_1", true);
    const ctx = filterOrderContextForVerification(session.currentOrderData as any, true);
    const paymentSpeech = buildOrderDetailSpeech(
      session,
      "what payment method was used",
      ctx,
    );
    expect(paymentSpeech).toMatch(/Visa|4242|shopify/i);

    const notifySpeech = buildOrderDetailSpeech(session, "where was the confirmation sent", ctx);
    expect(notifySpeech).toMatch(/fred@example\.com|notification/i);

    const payload = JSON.parse(
      toolResultForLlm({
        tool: "get_shopify_order_status",
        args: {},
        ok: true,
        status: "found",
        data: { status: "found", orderNumber: "48065", payment_method_last4: "4242" },
        elapsedMs: 1,
      }, { isVerifiedCaller: true }),
    ) as { instructions?: string };
    expect(String(payload.instructions ?? "")).toMatch(/never invent/i);
  });
});

describe("order detail permissions", () => {
  it("26-29 — non-verified gets title only; refuses price/shipping/address", () => {
    const session = seedSession("OD_1", false);
    const ctx = filterOrderContextForVerification(session.currentOrderData as any, false);
    expect(buildOrderDetailSpeech(session, "what is the item title", ctx)).toMatch(/Healing Book/i);

    const speech = buildOrderDetailSpeech(
      session,
      "tell me item title, item price, and shipping fee",
      ctx,
    );
    expect(speech).toMatch(/unverified number|public order status and tracking|verified account holder/i);
    expect(speech).not.toMatch(/\$12\.00|\$5\.00/i);

    const addr = buildOrderDetailSpeech(session, "what is the shipping address", ctx);
    expect(addr).toMatch(/cannot provide the shipping address|can't provide the shipping address|cannot share the shipping address/i);
  });

  it("30-31 — verified caller gets shipping address", () => {
    const session = seedSession("OD_2", true);
    const ctx = filterOrderContextForVerification(session.currentOrderData as any, true);
    const speech = buildOrderDetailSpeech(session, "what is the shipping address", ctx);
    expect(speech).toMatch(/123 Main St/i);
  });
});

describe("cart utterance parsing", () => {
  it("parses spoken quantities", () => {
    expect(parseCartQuantityFromSpeech("add 20 copies")).toBe(20);
    expect(parseCartQuantityFromSpeech("make it 5")).toBe(5);
    expect(isCartActionUtterance("Add 20 copies")).toBe(true);
  });

  it("suppresses catalog escalation when product context active", () => {
    const session = seedProductSession("CE_1");
    expect(shouldSuppressCatalogEscalation(session)).toBe(true);
  });
});
