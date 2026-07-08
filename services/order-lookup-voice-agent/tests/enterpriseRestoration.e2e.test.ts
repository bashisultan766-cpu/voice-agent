import { beforeEach, describe, expect, it, vi } from "vitest";
import { runOrchestratorTurn } from "../src/agents/conversationOrchestrator.js";
import { createCallSession } from "../src/agents/orderAgent.js";
import { applyCallerVerificationFromOrder } from "../src/agents/callerVerification.js";
import { addToCart, getCartSummary } from "../src/agents/cartManager.js";
import { getOrCreateActiveSession, recordTrackingPayload } from "../src/sovereign/activeSession.js";
import { clearAllCallMemories } from "../src/memory/callMemoryStore.js";
import { clearAllCallStates } from "../src/memory/callStateStore.js";
import { clearAllCallEventSessions, getAgentState } from "../src/platform/eventDispatcher.js";
import { clearAllTurnQueues } from "../src/runtime/turnExecutionQueue.js";
import { clearAllStreamBarriers } from "../src/runtime/streamTurnBarrier.js";
import { clearAllTurnHealth } from "../src/runtime/turnHealthMonitor.js";
import { resetPipelineGuard, enablePipelineGuardForTests } from "../src/guards/pipelineGuard.js";
import { resetToolExecutionGuard } from "../src/guards/toolExecutionGuard.js";
import { resetToolAccessGuard } from "../src/guards/toolAccessGuard.js";
import { setLlmAgentTurnOverride } from "../src/adapters/openaiAdapter.js";
import { defaultTestLlmAgentTurn } from "./helpers/llmAgentMock.js";
import * as shopifyStorefrontAdapter from "../src/adapters/shopifyStorefrontAdapter.js";
import * as resendEmailService from "../src/utils/resendEmailService.js";

const TRACKING = "9449050105795009634765";
const NOTEPAD_NUDGE_RE = /pen and notepad|write that correctly/i;

async function collectSpeech(
  session: ReturnType<typeof createCallSession>,
  text: string,
): Promise<string> {
  const parts: string[] = [];
  for await (const event of runOrchestratorTurn(session, text)) {
    if (event.type === "chunk") parts.push(event.chunk.text);
  }
  return parts.join(" ");
}

function logStep(step: number, label: string, session: ReturnType<typeof createCallSession>, speech: string): void {
  const active = getOrCreateActiveSession(session.callSid);
  console.log(
    `[RESTORE-E2E] step=${step} ${label} | verified=${session.isVerifiedCaller} | state=${active.currentState} | cachedIntent=${active.cachedIntent ?? "none"} | speech="${speech.slice(0, 140)}${speech.length > 140 ? "…" : ""}"`,
  );
}

describe("enterprise restoration phase 2 e2e", () => {
  beforeEach(() => {
    clearAllCallMemories();
    clearAllCallStates();
    clearAllCallEventSessions();
    clearAllTurnQueues();
    clearAllStreamBarriers();
    clearAllTurnHealth();
    resetPipelineGuard();
    enablePipelineGuardForTests(true);
    resetToolExecutionGuard();
    resetToolAccessGuard();
    setLlmAgentTurnOverride(defaultTestLlmAgentTurn);
    vi.restoreAllMocks();
  });

  it("runs Verify → Lookup → History → Cart Update → Escalation without notepad nudges on name/history", async () => {
    const session = createCallSession("CA_RESTORE_5", "+15551234567", "+18005551212");
    session.greetedThisCall = true;
    session.phase = "follow_up";

    vi.spyOn(shopifyStorefrontAdapter, "getOrderStatus").mockResolvedValue({
      status: "found",
      orderNumber: "21796",
      customerName: "Jamaica Thompson",
      customerEmail: "jamaica@example.com",
      customerPhone: "+15551234567",
      customerId: "gid://shopify/Customer/12345",
      totalOrderCount: 4,
      fulfillmentStatus: "fulfilled",
      trackingNumber: TRACKING,
      totalAmount: "$42.00",
      shippingAmount: "$5.99",
      paymentMethod: "Visa ending in 4242",
    } as shopifyStorefrontAdapter.OrderStatusResult);

    setLlmAgentTurnOverride(async (input) => {
      if (/\b21796\b/.test(input.userMessage) || /\blookup\b/i.test(input.userMessage)) {
        const { executeLlmTool } = await import("../src/adapters/llmToolExecutor.js");
        const exec = await executeLlmTool(
          "get_shopify_order_status",
          { orderNumber: "21796" },
          input.callSid,
          session,
        );
        return {
          speech: "I found order 21796. It is fulfilled.",
          toolExecutions: [exec],
          responseType: "order_found",
        };
      }
      if (/\b(order history|past orders)\b/i.test(input.userMessage)) {
        const { executeLlmTool } = await import("../src/adapters/llmToolExecutor.js");
        const exec = await executeLlmTool(
          "get_customer_history",
          { customerId: session.shopifyCustomerId ?? "" },
          input.callSid,
          session,
        );
        return {
          speech:
            "You have orders in January 2025 and March 2025. Which month would you like me to walk through?",
          toolExecutions: [exec],
          responseType: "order_found",
        };
      }
      if (/\b(change to 5|five copies)\b/i.test(input.userMessage)) {
        const { executeLlmTool } = await import("../src/adapters/llmToolExecutor.js");
        const exec = await executeLlmTool(
          "add_to_cart",
          {
            set_absolute_quantity: true,
            items: [
              {
                title: "Test Book",
                variant_id: "gid://shopify/ProductVariant/999",
                unit_price: "12.99",
                quantity: 5,
              },
            ],
          },
          input.callSid,
          session,
        );
        return {
          speech: "Done — you now have 5 copies of Test Book in your cart.",
          toolExecutions: [exec],
          responseType: "confirmed_product",
        };
      }
      if (/\b(escalat|support team|forward my details)\b/i.test(input.userMessage)) {
        const { executeLlmTool } = await import("../src/adapters/llmToolExecutor.js");
        const exec = await executeLlmTool(
          "send_support_escalation",
          {
            customerEmail: "jamaica@example.com",
            customerName: "Jamaica Thompson",
            issueSummary: "Caller requested human support after cart update.",
          },
          input.callSid,
          session,
        );
        return {
          speech: "I have sent your request to the support team. They will contact you shortly.",
          toolExecutions: [exec],
          responseType: "general_help",
        };
      }
      return defaultTestLlmAgentTurn(input);
    });

    vi.spyOn(shopifyStorefrontAdapter, "getCustomerHistory").mockResolvedValue({
      status: "found",
      orderCount: 2,
      orders: [
        {
          orderNumber: "21796",
          monthYear: "January 2025",
          totalAmount: "$42.00",
          status: "fulfilled",
          items: ["Test Book"],
        },
        {
          orderNumber: "21001",
          monthYear: "March 2025",
          totalAmount: "$18.50",
          status: "refunded",
          items: ["Another Book"],
        },
      ],
    });

    const escalationSpy = vi.spyOn(resendEmailService, "sendSupportEscalation").mockResolvedValue({
      ok: true,
      messageId: "msg_restore_test",
    });

    // Step 1 — Verify caller (silent Twilio ↔ Shopify match)
    applyCallerVerificationFromOrder(session, {
      status: "found",
      orderNumber: "21796",
      customerName: "Jamaica Thompson",
      customerPhone: "+15551234567",
      customerId: "gid://shopify/Customer/12345",
      totalOrderCount: 4,
    } as shopifyStorefrontAdapter.OrderStatusResult);
    session.currentOrderData = {
      order_number: "21796",
      customer_name: "Jamaica Thompson",
      tracking_number: TRACKING,
      fulfillment_status: "fulfilled",
      total_amount: "$42.00",
      shipping_amount: "$5.99",
      payment_method: "Visa ending in 4242",
    };
    logStep(1, "verify-caller", session, `isVerifiedCaller=${session.isVerifiedCaller}`);
    expect(session.isVerifiedCaller).toBe(true);

    // Arm legacy notepad trap — customer name / history must still exit cleanly.
    recordTrackingPayload(session.callSid, TRACKING);
    expect(getOrCreateActiveSession(session.callSid).currentState).toBe("awaiting_notepad_ready");

    // Step 2 — Lookup order (LLM tool path)
    const lookupSpeech = await collectSpeech(session, "please lookup order 21796");
    logStep(2, "lookup-order", session, lookupSpeech);
    expect(lookupSpeech).toMatch(/21796|fulfilled/i);
    expect(lookupSpeech).not.toMatch(NOTEPAD_NUDGE_RE);

    // Step 3 — Customer name while notepad trap armed (must NOT nudge)
    recordTrackingPayload(session.callSid, TRACKING);
    const nameSpeech = await collectSpeech(session, "what is the customer name on this order");
    logStep(3, "customer-name-exit", session, nameSpeech);
    expect(nameSpeech).toMatch(/Jamaica Thompson/i);
    expect(nameSpeech).not.toMatch(NOTEPAD_NUDGE_RE);
    expect(getOrCreateActiveSession(session.callSid).currentState).toBe("order_active");

    // Step 4 — Order history (must NOT nudge)
    recordTrackingPayload(session.callSid, TRACKING);
    const historySpeech = await collectSpeech(session, "what is my order history");
    logStep(4, "order-history", session, historySpeech);
    expect(historySpeech).toMatch(/January 2025|March 2025|month/i);
    expect(historySpeech).not.toMatch(NOTEPAD_NUDGE_RE);
    expect(shopifyStorefrontAdapter.getCustomerHistory).toHaveBeenCalled();

    // Step 5 — Cart absolute quantity update
    addToCart(session, [
      {
        title: "Test Book",
        variant_id: "gid://shopify/ProductVariant/999",
        unit_price: "12.99",
        quantity: 2,
      },
    ]);
    const cartSpeech = await collectSpeech(session, "change to 5 copies of Test Book");
    logStep(5, "cart-update", session, cartSpeech);
    expect(cartSpeech).toMatch(/5 copies/i);
    expect(getCartSummary(session).items[0]?.quantity).toBe(5);

    // Step 6 — Escalation with transcript in email body
    getAgentState(session.callSid).messages.push(
      { role: "user", content: "I need a human please" },
      { role: "assistant", content: "Let me forward your details to support." },
    );
    const escalationSpeech = await collectSpeech(
      session,
      "please escalate this to the support team",
    );
    logStep(6, "escalation", session, escalationSpeech);
    expect(escalationSpeech).toMatch(/support team/i);
    expect(escalationSpy).toHaveBeenCalled();
    const summary = escalationSpy.mock.calls[0]?.[3] ?? "";
    expect(summary).toMatch(/Session context/i);
    expect(summary).toMatch(/Recent transcript/i);
    expect(summary).toMatch(/human please/i);
  });
});
