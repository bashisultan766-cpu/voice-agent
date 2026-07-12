import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCallerIntent } from "../src/agents/callerIntent.js";
import { runOrchestratorTurn } from "../src/agents/conversationOrchestrator.js";
import { createCallSession } from "../src/agents/orderAgent.js";
import { applyCallerVerificationFromOrder } from "../src/agents/callerVerification.js";
import {
  buildMonthDrillDownSpeech,
  buildUnverifiedOrderHistorySpeech,
  buildVerifiedHistoryOverviewSpeech,
  setOrderHistoryContext,
} from "../src/agents/orderHistoryFlow.js";
import { buildOrderFieldQuerySpeech } from "../src/agents/orderFollowUpSpeech.js";
import {
  isRestrictedFieldQueryForUnverified,
  buildUnverifiedRestrictedFieldRefusal,
} from "../src/agents/orderContextPrivacy.js";
import { shouldRefuseUnverifiedFieldQuery } from "../src/agents/responsePolicy.js";
import { saveActiveOrderContext } from "../src/agents/sessionManager.js";
import { clearAllConversationFlowModes } from "../src/agents/conversationFlowState.js";
import { clearAllCallMemories } from "../src/memory/callMemoryStore.js";
import { clearAllCallStates } from "../src/memory/callStateStore.js";
import { clearAllCallEventSessions } from "../src/platform/eventDispatcher.js";
import { clearAllTurnQueues } from "../src/runtime/turnExecutionQueue.js";
import { clearAllStreamBarriers } from "../src/runtime/streamTurnBarrier.js";
import { clearAllTurnHealth } from "../src/runtime/turnHealthMonitor.js";
import { resetPipelineGuard, enablePipelineGuardForTests } from "../src/guards/pipelineGuard.js";
import { resetToolExecutionGuard } from "../src/guards/toolExecutionGuard.js";
import { resetToolAccessGuard } from "../src/guards/toolAccessGuard.js";
import { setLlmAgentTurnOverride } from "../src/adapters/openaiAdapter.js";
import { defaultTestLlmAgentTurn } from "./helpers/llmAgentMock.js";
import * as shopifyStorefrontAdapter from "../src/adapters/shopifyStorefrontAdapter.js";
import type { CallSession } from "../src/types/order.js";

const HISTORY_ORDERS: shopifyStorefrontAdapter.CustomerHistoryOrderSummary[] = [
  {
    orderNumber: "#21698",
    monthYear: "June 2025",
    totalAmount: "$42.00 USD",
    status: "fulfilled",
    items: "Sample Book",
  },
  {
    orderNumber: "#21001",
    monthYear: "September 2025",
    totalAmount: "$18.50 USD",
    status: "refunded",
    items: "Another Book",
  },
];

async function collectSpeech(session: CallSession, text: string): Promise<string> {
  const parts: string[] = [];
  for await (const event of runOrchestratorTurn(session, text)) {
    if (event.type === "chunk") parts.push(event.chunk.text);
  }
  return parts.join(" ");
}

function seedVerifiedOrderSession(callSid: string, phone = "+15551234567"): CallSession {
  const session = createCallSession(callSid, phone, "+18005551212");
  session.greetedThisCall = true;
  session.phase = "follow_up";
  applyCallerVerificationFromOrder(session, {
    status: "found",
    orderNumber: "21698",
    customerName: "Jane Doe",
    customerPhone: phone,
    customerId: "gid://shopify/Customer/12345",
    totalOrderCount: 10,
  } as shopifyStorefrontAdapter.OrderStatusResult);
  saveActiveOrderContext(session, {
    order_number: "21698",
    customer_name: "Jane Doe",
    total_amount: "$42.00 USD",
    shipping_amount: "$4.99 USD",
    payment_method: "Visa ending in 4242",
    order_confirmation_email: "jane@example.com",
    physical_items: [{ title: "Sample Book", quantity: 1, price: "$42.00 USD" }],
    item_count: 1,
    fulfillment_status: "fulfilled",
  });
  return session;
}

function seedUnverifiedOrderSession(callSid: string): CallSession {
  const session = createCallSession(callSid, "+15550001111", "+18005551212");
  session.greetedThisCall = true;
  session.phase = "follow_up";
  session.isVerifiedCaller = false;
  applyCallerVerificationFromOrder(session, {
    status: "found",
    orderNumber: "21698",
    customerName: "Jane Doe",
    customerPhone: "+15551234567",
    customerId: "gid://shopify/Customer/12345",
    totalOrderCount: 10,
  } as shopifyStorefrontAdapter.OrderStatusResult);
  saveActiveOrderContext(session, {
    order_number: "21698",
    customer_name: "Jane Doe",
    shipping_address: "123 Private Lane",
    total_amount: "$42.00 USD",
    physical_items: [{ title: "Sample Book", quantity: 1 }],
  });
  return session;
}

describe("production intent scenarios", () => {
  beforeEach(() => {
    clearAllCallMemories();
    clearAllCallStates();
    clearAllCallEventSessions();
    clearAllTurnQueues();
    clearAllStreamBarriers();
    clearAllTurnHealth();
    clearAllConversationFlowModes();
    resetPipelineGuard();
    enablePipelineGuardForTests(true);
    resetToolExecutionGuard();
    resetToolAccessGuard();
    setLlmAgentTurnOverride(defaultTestLlmAgentTurn);
    vi.restoreAllMocks();
  });

  it("1 — verified caller asks for previous order history", async () => {
    vi.spyOn(shopifyStorefrontAdapter, "getCustomerHistory").mockResolvedValue({
      status: "found",
      orderCount: 10,
      orders: HISTORY_ORDERS,
    });
    const session = seedVerifiedOrderSession("CA_PROD_1");
    const speech = await collectSpeech(session, "tell me my previous order history");
    expect(speech).toMatch(/10 past orders/i);
    expect(speech).toMatch(/June/i);
    expect(speech).toMatch(/September/i);
    expect(speech).toMatch(/which month/i);
  });

  it("2 — non-verified caller asks for previous order history (count only)", async () => {
    const session = seedUnverifiedOrderSession("CA_PROD_2");
    const speech = await collectSpeech(session, "tell me previous order history");
    expect(speech).toContain(buildUnverifiedOrderHistorySpeech(10));
    expect(speech).toMatch(/forward your request to our support team/i);
    expect(speech).not.toMatch(/June|September|Sample Book/i);
  });

  it("3 — verified caller asks about June order after history context", async () => {
    const session = seedVerifiedOrderSession("CA_PROD_3");
    setOrderHistoryContext(session, HISTORY_ORDERS, 10);
    expect(resolveCallerIntent("tell me about June", session)).toBe("order_history");
    const speech = buildMonthDrillDownSpeech(session.orderHistoryContext!, "June");
    expect(speech).toMatch(/June/i);
    expect(speech).toMatch(/Sample Book/i);
  });

  it("4 — verified caller asks for title of current order only", () => {
    const context = {
      item_count: 1,
      physical_items: [{ title: "Sample Book", quantity: 1, price: "$42.00 USD" }],
    } as any;
    const speech = buildOrderFieldQuerySpeech("what is the title of that order", context);
    expect(speech).toMatch(/Sample Book/i);
    expect(speech).not.toMatch(/shipping|total/i);
  });

  it("5 — verified caller asks for shipping fee only", () => {
    const context = {
      item_count: 1,
      shipping_amount: "$4.99 USD",
      physical_items: [{ title: "Sample Book", quantity: 1 }],
    } as any;
    const speech = buildOrderFieldQuerySpeech("what was the shipping fee", context);
    expect(speech).toMatch(/4\.99/);
    expect(speech).not.toMatch(/Sample Book/i);
  });

  it("6 — verified caller asks where confirmation was sent", () => {
    const context = {
      order_confirmation_email: "jane@example.com",
      customer_email: "jane@example.com",
    } as any;
    const speech = buildOrderFieldQuerySpeech("where was confirmation sent", context);
    expect(speech).toMatch(/jane@example.com|jane at example/i);
  });

  it("7 — non-verified caller asks for shipping address", async () => {
    const session = seedUnverifiedOrderSession("CA_PROD_7");
    expect(isRestrictedFieldQueryForUnverified("what is the shipping address")).toBe(true);
    expect(isRestrictedFieldQueryForUnverified("what is the payment method")).toBe(true);
    expect(isRestrictedFieldQueryForUnverified("what is the total amount")).toBe(true);
    const speech = await collectSpeech(session, "what is the shipping address");
    expect(speech).toMatch(/can't provide the shipping address|cannot share the shipping address|not verified|unverified number/i);
    expect(speech).not.toMatch(/Private Lane/i);
    expect(speech).not.toMatch(/not on file/i);
  });

  it("7b — non-verified caller cannot hear customer name (secure field)", async () => {
    const session = seedUnverifiedOrderSession("CA_PROD_7B");
    const speech = await collectSpeech(session, "what is the customer name on this order");
    expect(speech).toMatch(/unverified number|verified account holder|public order status|not on file/i);
    expect(speech).not.toMatch(/under the name Jane Doe/i);
    expect(speech).not.toMatch(/This order is under the name/i);
  });

  it("8 — non-verified caller can ask for public order status details only", async () => {
    const session = seedUnverifiedOrderSession("CA_PROD_8");
    expect(shouldRefuseUnverifiedFieldQuery(session, "what is the tracking number")).toBe(false);
    expect(shouldRefuseUnverifiedFieldQuery(session, "what is the total amount")).toBe(true);
    const speech = await collectSpeech(session, "what is the order status");
    expect(speech).toMatch(/order|status|fulfilled|tracking|item|Sample Book/i);
    expect(speech).not.toMatch(/Private Lane/i);
    expect(speech).not.toMatch(/\$42\.00/i);
  });

  it("9 — customer switches from order history to buying flow", () => {
    const session = seedVerifiedOrderSession("CA_PROD_9");
    setOrderHistoryContext(session, HISTORY_ORDERS, 10);
    expect(resolveCallerIntent("I want to buy a book", session)).toBe("catalog");
  });

  it("10 — customer provides ISBN routes to catalog", () => {
    const session = createCallSession("CA_PROD_10", "+15551234567", "+18005551212");
    expect(resolveCallerIntent("do you have ISBN 9780143127550", session)).toBe("catalog");
  });

  it("11 — customer provides exact title routes to catalog", () => {
    const session = createCallSession("CA_PROD_11", "+15551234567", "+18005551212");
    expect(
      resolveCallerIntent('I am looking for a book titled "Dad to Son"', session),
    ).toBe("catalog");
  });

  it("12 — out of stock ISBN uses warehouse message", async () => {
    const { toolResultForLlm } = await import("../src/adapters/llmToolExecutor.js");
    const { OUT_OF_STOCK_ISBN_MESSAGE } = await import("../src/constants/systemMessages.js");
    const payload = toolResultForLlm({
      tool: "search_shopify_book_by_isbn",
      args: { isbn: "9780143127550" },
      ok: true,
      status: "found",
      data: {
        status: "found",
        bookName: "Test Book",
        price: "$12.99",
        inStock: false,
        variantId: "gid://shopify/ProductVariant/1",
      },
      elapsedMs: 1,
    });
    expect(payload).toContain(OUT_OF_STOCK_ISBN_MESSAGE);
  });

  it("13 — product price must come from Shopify tool data not invention", async () => {
    const { toolResultForLlm } = await import("../src/adapters/llmToolExecutor.js");
    const payload = toolResultForLlm({
      tool: "search_shopify_book_by_title",
      args: { title: "Exact Title" },
      ok: true,
      status: "found",
      data: {
        status: "found",
        bookName: "Exact Title",
        price: "$19.95 USD",
        inStock: true,
        exactMatch: true,
        variantId: "gid://shopify/ProductVariant/2",
      },
      elapsedMs: 1,
    });
    expect(payload).toContain("$19.95 USD");
    expect(payload).toMatch(/variant_id|variantId/i);
  });

  it("14 — customer asks only one specific question (total only)", () => {
    const context = {
      total_amount: "$42.00 USD",
      shipping_amount: "$4.99 USD",
      item_count: 1,
      physical_items: [{ title: "Sample Book", quantity: 1 }],
    } as any;
    const speech = buildOrderFieldQuerySpeech("what was the total", context);
    expect(speech).toMatch(/42\.00/);
    expect(speech).not.toMatch(/Sample Book|shipping/i);
  });

  it("15 — verified caller full order details offers structured follow-up", () => {
    const context = {
      order_number: "21698",
      customer_name: "Jane Doe",
      fulfillment_status: "fulfilled",
      total_amount: "$42.00 USD",
      shipping_amount: "$4.99 USD",
      physical_items: [{ title: "Sample Book", quantity: 1 }],
    } as any;
    const speech = buildOrderFieldQuerySpeech("tell me all the details of this order", context);
    expect(speech).toMatch(/21698/i);
    expect(speech).toMatch(/titles|total|shipping|tracking/i);
  });

  it("unverified refusal uses registered customer name", () => {
    const refusal = buildUnverifiedRestrictedFieldRefusal("Jane Doe");
    expect(refusal).toContain("Jane Doe");
    expect(refusal).toMatch(/unverified number/i);
    expect(refusal).not.toMatch(/not on file/i);
  });

  it("verified history overview groups months without dumping items", () => {
    const ctx = setOrderHistoryContext(
      { callSid: "CA", from: "", to: "", phase: "follow_up", orderNumberAttempts: 0, createdAt: 0 } as CallSession,
      HISTORY_ORDERS,
      10,
    );
    const speech = buildVerifiedHistoryOverviewSpeech(ctx);
    expect(speech).toMatch(/10 past orders/i);
    expect(speech).not.toMatch(/Another Book|Sample Book/i);
  });
});
