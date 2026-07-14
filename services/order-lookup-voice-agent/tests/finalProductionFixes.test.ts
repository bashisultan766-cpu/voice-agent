import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCallSession } from "../src/agents/orderAgent.js";
import {
  resolveEmailConfirmationTurn,
  startEmailCapture,
  registerEmailWorkflowExecutor,
} from "../src/agents/emailConfirmationManager.js";
import {
  applyPartialEmailCorrection,
  buildEmailConfirmationSpeech,
  buildUpdatedEmailConfirmationSpeech,
  extractEmailFromSpeech,
  spellEmailHyphenForTTS,
} from "../src/utils/emailCapture.js";
import { resolveCallerIntent } from "../src/agents/callerIntent.js";
import {
  clearAllConversationFlowModes,
  setConversationFlowMode,
} from "../src/agents/conversationFlowState.js";
import {
  isProductSearchContextActive,
  syncActiveWorkflowContext,
} from "../src/agents/workflowContext.js";
import { applyCallerVerificationFromOrder } from "../src/agents/callerVerification.js";
import { filterOrderContextForVerification } from "../src/agents/orderContextPrivacy.js";
import { getActiveOrderContext, saveActiveOrderContext } from "../src/agents/sessionManager.js";
import { buildOrderDetailSpeech } from "../src/agents/orderDetailBuilder.js";
import { buildOrderFieldQuerySpeech } from "../src/agents/orderFollowUpSpeech.js";
import {
  buildUnverifiedOrderHistorySpeech,
  buildVerifiedHistoryOverviewSpeech,
  buildMonthDrillDownSpeech,
  setOrderHistoryContext,
} from "../src/agents/orderHistoryFlow.js";
import type { CallSession } from "../src/types/order.js";

const ORDER_CONTEXT = {
  order_number: "48065",
  customer_name: "Frederick Marcalus",
  shipping_address: "123 Main St, Austin TX",
  physical_items: [{ title: "Healing Book", quantity: 1, price: "$12.00 USD" }],
  item_count: 1,
  subtotal_amount: "$12.00 USD",
  shipping_amount: "$5.00 USD",
  total_amount: "$17.00 USD",
  fulfillment_status: "fulfilled",
  tracking_number: "1Z999AA10123456784",
  order_confirmation_email: "fred@example.com",
  customer_phone: "+15551234567",
};

function seedSession(callSid: string, verified: boolean): CallSession {
  const phone = verified ? "+15551234567" : "+15550001111";
  const session = createCallSession(callSid, phone, "+18005551212");
  session.orderContextConfirmed = true;
  saveActiveOrderContext(session, { ...ORDER_CONTEXT });
  applyCallerVerificationFromOrder(session, {
    status: "found",
    orderNumber: "48065",
    customerName: "Frederick Marcalus",
    customerPhone: "+15551234567",
    customerId: "gid://shopify/Customer/1",
    totalOrderCount: 10,
  } as any);
  if (!verified) session.isVerifiedCaller = false;
  return session;
}

describe("email confirmation — full flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    registerEmailWorkflowExecutor("payment_link", async () => ({
      ok: true,
      successSpeech: "Payment link sent.",
      failureSpeech: "Failed.",
    }));
  });

  it("1-4 — extracts, spells, and asks confirmation", async () => {
    const session = createCallSession("EM_1", "+1", "+1");
    startEmailCapture(session, "payment_link");
    const turn = await resolveEmailConfirmationTurn(
      session,
      "bashisultan766 at gmail dot com",
    );
    expect(turn.handled).toBe(true);
    expect(turn.speech).toMatch(/I have your email as/i);
    expect(spellEmailHyphenForTTS("bashisultan766@gmail.com")).toMatch(/B-A-S-H-I/i);
    expect(session.emailConfirmation?.normalizedEmail).toBe("bashisultan766@gmail.com");
  });

  it("5-9 — rejection discards old email, stores latest, confirms once", async () => {
    const session = createCallSession("EM_2", "+1", "+1");
    const sendSpy = vi.fn().mockResolvedValue({
      ok: true,
      successSpeech: "Support sent.",
      failureSpeech: "Failed.",
    });
    registerEmailWorkflowExecutor("support_escalation", sendSpy);
    startEmailCapture(session, "support_escalation");

    await resolveEmailConfirmationTurn(session, "wrong at gmail dot com");
    await resolveEmailConfirmationTurn(session, "no that is wrong");
    await resolveEmailConfirmationTurn(session, "right at gmail dot com");
    expect(session.emailConfirmation?.normalizedEmail).toBe("right@gmail.com");
    expect(buildUpdatedEmailConfirmationSpeech("right@gmail.com")).toMatch(
      /Understood\. I have updated it/i,
    );

    const confirm = await resolveEmailConfirmationTurn(session, "yes that is correct");
    expect(confirm.speech).toMatch(/Support sent/i);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][1]).toBe("right@gmail.com");
  });

  it("10 — does not send twice without resend request", async () => {
    const session = createCallSession("EM_3", "+1", "+1");
    const sendSpy = vi.fn().mockResolvedValue({
      ok: true,
      successSpeech: "Sent once.",
      failureSpeech: "Failed.",
    });
    registerEmailWorkflowExecutor("payment_link", sendSpy);
    startEmailCapture(session, "payment_link");
    await resolveEmailConfirmationTurn(session, "once at gmail dot com");
    await resolveEmailConfirmationTurn(session, "yes");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const again = await resolveEmailConfirmationTurn(session, "yes send again");
    expect(again.handled).toBe(false);
  });

  it("defers unrelated questions during email capture to the LLM", async () => {
    const session = createCallSession("EM_4", "+1", "+1");
    startEmailCapture(session, "support_escalation");
    const deferred = await resolveEmailConfirmationTurn(session, "what is the weather today");
    expect(deferred.handled).toBe(false);
    expect(session.emailConfirmation?.phase).toBe("collect_email");
  });

  it("aborts email capture when caller pivots to tracking", async () => {
    const session = createCallSession("EM_ABORT", "+1", "+1");
    session.supportEscalation = {
      state: "non_verified_private_info_blocked",
      requestedInfo: "customer name",
      escalationReason: "vault request",
    };
    startEmailCapture(session, "support_escalation");
    const released = await resolveEmailConfirmationTurn(session, "never mind just give me my tracking ID");
    expect(released.handled).toBe(false);
    expect(session.emailConfirmation?.phase).toBe("idle");
    expect(session.supportEscalation?.state).toBe("normal");
  });

  it("aborts email capture on order lookup pivot", async () => {
    const session = createCallSession("EM_PIVOT", "+1", "+1");
    startEmailCapture(session, "support_escalation");
    const released = await resolveEmailConfirmationTurn(session, "check my order number");
    expect(released.handled).toBe(false);
    expect(session.emailConfirmation?.phase).toBe("idle");
  });
});

describe("partial email correction", () => {
  it("11 — replace M with N", () => {
    const updated = applyPartialEmailCorrection("bashim@gmail.com", "replace M with N");
    expect(updated).toBe("bashin@gmail.com");
  });

  it("12 — double A", () => {
    const updated = applyPartialEmailCorrection("bashi@gmail.com", "there are double A's");
    expect(updated).toBe("bashia@gmail.com");
  });

  it("13 — use Yahoo instead of Gmail", () => {
    const updated = applyPartialEmailCorrection("user@gmail.com", "use Yahoo instead of Gmail");
    expect(updated).toBe("user@yahoo.com");
  });

  it("14 — repeat slowly letter by letter", async () => {
    const session = createCallSession("EM_5", "+1", "+1");
    startEmailCapture(session, "payment_link");
    await resolveEmailConfirmationTurn(session, "slow at gmail dot com");
    const repeat = await resolveEmailConfirmationTurn(session, "repeat slowly letter by letter");
    expect(repeat.speech).toMatch(/I have your email as/i);
  });

  it("15 — latest corrected email only", () => {
    expect(extractEmailFromSpeech("bashisultan766 at gmail dot com")).toBe(
      "bashisultan766@gmail.com",
    );
    const corrected = applyPartialEmailCorrection(
      "bashisultan766@gmail.com",
      "not Sultan, it is Sultaan",
    );
    expect(corrected).toBe("bashisultaan766@gmail.com");
  });

  it("15b — contextual segment repair Sub → Saab", () => {
    const corrected = applyPartialEmailCorrection(
      "bashisub766@gmail.com",
      "Not Sub, it's Saab",
    );
    expect(corrected).toBe("bashisaab766@gmail.com");
  });

  it("15c — Semantic Slot PartialCorrection mid-confirmation (Sub → Saab)", async () => {
    const { applyPartialCorrection, parsePendingEmail } = await import(
      "../src/utils/emailCapture.js"
    );
    const session = createCallSession("EM_SLOT", "+1", "+1");
    startEmailCapture(session, "payment_link");
    await resolveEmailConfirmationTurn(session, "bashi sub 766 at gmail dot com");
    // Force a known pending address if STT normalization differs
    if (session.emailConfirmation) {
      session.emailConfirmation.normalizedEmail = "bashisub766@gmail.com";
      session.emailConfirmation.pendingEmailSlots = parsePendingEmail("bashisub766@gmail.com");
      session.emailConfirmation.phase = "pending_confirmation";
    }

    const structured = applyPartialCorrection("bashisub766@gmail.com", "Not Sub, it's Saab");
    expect(structured?.email).toBe("bashisaab766@gmail.com");
    expect(structured?.correction.slot).toMatch(/part1|part2|local/);
    expect(structured?.correction.to).toBe("saab");

    const turn = await resolveEmailConfirmationTurn(session, "Not Sub, it's Saab");
    expect(turn.handled).toBe(true);
    expect(turn.speech).toMatch(/Understood\. I have updated the spelling to S-A-A-B/i);
    expect(turn.speech).toMatch(/Is that correct/i);
    expect(session.emailConfirmation?.normalizedEmail).toBe("bashisaab766@gmail.com");
    expect(session.emailConfirmation?.pendingEmailSlots?.full).toBe("bashisaab766@gmail.com");
    expect(session.emailConfirmation?.lastPartialCorrection?.to).toBe("saab");
  });
});

describe("product ISBN / title intent", () => {
  beforeEach(() => {
    clearAllConversationFlowModes();
  });

  it("16-18 — buy book then ISBN routes to catalog", () => {
    const session = createCallSession("PR_1", "+1", "+1");
    expect(resolveCallerIntent("I want to buy a book", session)).toBe("catalog");
    setConversationFlowMode(session.callSid, "PURCHASE_FLOW");
    session.lastOrchestratorIntent = "catalog";
    syncActiveWorkflowContext(session);
    expect(isProductSearchContextActive(session)).toBe(true);
    expect(resolveCallerIntent("9780143127550", session)).toBe("catalog");
  });

  it("19-20 — title search routes to catalog not order lookup", () => {
    const session = createCallSession("PR_2", "+1", "+1");
    setConversationFlowMode(session.callSid, "PURCHASE_FLOW");
    session.lastOrchestratorIntent = "catalog";
    syncActiveWorkflowContext(session);
    expect(resolveCallerIntent("find this title Rich Dad Poor Dad", session)).toBe("catalog");
  });

  it("21 — numeric ISBN in product context is not order lookup", () => {
    const session = createCallSession("PR_3", "+1", "+1");
    setConversationFlowMode(session.callSid, "PURCHASE_FLOW");
    session.lastOrchestratorIntent = "catalog";
    expect(resolveCallerIntent("0143127550", session)).toBe("catalog");
    expect(resolveCallerIntent("check my order", session)).toBe("order_lookup");
  });

  it("order lookup still works without product context", () => {
    const session = createCallSession("PR_4", "+1", "+1");
    expect(resolveCallerIntent("where is my order", session)).toBe("order_lookup");
  });
});

describe("non-verified order detail disclosure", () => {
  it("22-27 — title public; price and shipping fee refused for non-verified", () => {
    const session = seedSession("NV_1", false);
    const ctx = filterOrderContextForVerification(getActiveOrderContext(session) as any, false);
    expect(buildOrderDetailSpeech(session, "what is the item title", ctx)).toMatch(/Healing Book/i);
    expect(buildOrderDetailSpeech(session, "what is the item price", ctx)).toMatch(
      /unverified number|public order status and tracking|verified account holder/i,
    );
    expect(buildOrderDetailSpeech(session, "what is the shipping fee", ctx)).toMatch(
      /unverified number|public order status and tracking|verified account holder/i,
    );
  });

  it("28-29 — combined price/shipping/total refused for unverified", () => {
    const session = seedSession("NV_2", false);
    const ctx = filterOrderContextForVerification(getActiveOrderContext(session) as any, false);
    const speech = buildOrderDetailSpeech(
      session,
      "tell me item title, item price, shipping fee, and total amount",
      ctx,
    );
    expect(speech).toMatch(/unverified number|public order status and tracking|verified account holder/i);
    expect(speech).not.toMatch(/\$12\.00|\$5\.00|\$17\.00/i);
  });

  it("30-31 — refuses confirmation email for unverified callers", () => {
    const session = seedSession("NV_3", false);
    const ctx = filterOrderContextForVerification(getActiveOrderContext(session) as any, false);
    const speech = buildOrderDetailSpeech(session, "where was the confirmation sent", ctx);
    expect(speech).toMatch(/unverified number|public order status and tracking|verified account holder/i);
    expect(speech).not.toMatch(/fred@example\.com|fred at example/i);
    const legacy = buildOrderFieldQuerySpeech(
      "where was the confirmation sent",
      ctx,
      false,
    );
    expect(legacy).not.toMatch(/fred@example\.com|fred at example/i);
    expect(legacy).toMatch(
      /unverified number|public order status and tracking|verified account holder|not have a confirmation|not on file/i,
    );
  });

  it("32-33 — refuses shipping address", () => {
    const session = seedSession("NV_4", false);
    const ctx = filterOrderContextForVerification(getActiveOrderContext(session) as any, false);
    const speech = buildOrderDetailSpeech(session, "what is the shipping address", ctx);
    expect(speech).toMatch(
      /can't read (?:out )?the exact shipping address|cannot provide the shipping address|can't provide the shipping address|cannot share the shipping address/i,
    );
    expect(speech).not.toMatch(/123 Main St/i);
  });

  it("34-35 — previous order count only", () => {
    expect(buildUnverifiedOrderHistorySpeech(10)).toMatch(/10 previous orders/i);
    expect(buildUnverifiedOrderHistorySpeech(10)).toMatch(/can't provide detailed order history/i);
  });
});

describe("verified order detail disclosure", () => {
  it("36-37 — shipping address for verified caller", () => {
    const session = seedSession("V_1", true);
    const ctx = filterOrderContextForVerification(getActiveOrderContext(session) as any, true);
    const speech = buildOrderDetailSpeech(session, "what is the shipping address", ctx);
    expect(speech).toMatch(/123 Main St/i);
  });

  it("38-39 — detailed order history for verified caller", () => {
    const session = seedSession("V_2", true);
    setOrderHistoryContext(
      session,
      [
        {
          orderNumber: "#100",
          monthYear: "June 2025",
          totalAmount: "$20.00",
          status: "fulfilled",
          items: "Book A",
        },
      ],
      10,
    );
    const speech = buildVerifiedHistoryOverviewSpeech(session.orderHistoryContext!);
    expect(speech).toMatch(/10 past orders/i);
    expect(speech).toMatch(/June/i);
    const june = buildMonthDrillDownSpeech(session.orderHistoryContext!, "June");
    expect(june).toMatch(/Book A/i);
  });
});
