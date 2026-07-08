import { describe, expect, it, beforeEach } from "vitest";
import {
  resolveCallerIntent,
  isIntentSwitchAwayFromTracking,
  isSupportEscalationRequest,
} from "../src/agents/callerIntent.js";
import { resolveTrackingPhaseGate } from "../src/agents/conversationOrchestrator.js";
import { getOrCreateActiveSession, updateActiveSession } from "../src/sovereign/activeSession.js";
import { completeTrackingDictation } from "../src/agents/dictationTool.js";
import { buildOrderFieldQuerySpeech } from "../src/agents/orderFollowUpSpeech.js";
import { saveActiveOrderContext } from "../src/agents/sessionManager.js";
import type { CallSession } from "../src/types/order.js";

function mockSession(callSid: string): CallSession {
  const session = {
    callSid,
    from: "+15551234567",
    to: "+15559876543",
    phase: "follow_up",
    greetedThisCall: true,
    isVerifiedCaller: false,
  } as CallSession;
  saveActiveOrderContext(session, {
    order_number: "21698",
    customer_name: "Jane Doe",
    tracking_number: "1Z999AA10123456784",
    shipping_amount: "4.99 USD",
    physical_items: [{ title: "Sample Book", quantity: 1, price: "19.99" }],
  });
  return session;
}

describe("intent-first switching", () => {
  const callSid = "CA_intent_switch_test";

  beforeEach(() => {
    updateActiveSession(callSid, {
      currentState: "tracking_dictation",
      cachedIntent: "tracking",
      lastSpokenPayload: {
        kind: "tracking",
        trackingForTts: "one Z nine nine nine",
        trackingRaw: "1Z999AA10123456784",
      },
      lastSpokenIndex: 3,
      isNotepadReady: true,
      spatialIndex: [],
    });
  });

  it("classifies buy a product during tracking dictation as catalog", () => {
    const session = mockSession(callSid);
    const intent = resolveCallerIntent("leave the product, I want to buy a product", session);
    expect(intent).toBe("catalog");
    expect(isIntentSwitchAwayFromTracking("I want to buy a product", session)).toBe(true);
  });

  it("classifies order details during tracking dictation as order_field_query", () => {
    const session = mockSession(callSid);
    const intent = resolveCallerIntent("never mind tracking, tell me the order details", session);
    expect(intent).toBe("order_field_query");
  });

  it("classifies supporter team request as support_escalation", () => {
    expect(isSupportEscalationRequest("forward this to the supporter team, call me")).toBe(true);
    const session = mockSession(callSid);
    const intent = resolveCallerIntent("I want to talk to the supporter team", session);
    expect(intent).toBe("support_escalation");
  });

  it("classifies post-tracking item/title follow-up as order_field_query not catalog", () => {
    completeTrackingDictation(callSid);
    const session = mockSession(callSid);
    const utterance =
      "yes, tell me how many items are there in this product and what is the title";
    expect(resolveCallerIntent(utterance, session)).toBe("order_field_query");
    const speech = buildOrderFieldQuerySpeech(utterance, session.currentOrderData as any);
    expect(speech).toMatch(/Sample Book/i);
    expect(speech).toMatch(/1 book/i);
  });

  it("releases tracking gate when caller pivots to catalog mid-dictation", () => {
    const session = mockSession(callSid);
    const gate = resolveTrackingPhaseGate("tell me good books to buy", session);
    expect(gate.handled).toBe(false);
    const active = getOrCreateActiveSession(callSid);
    expect(active.currentState).toBe("order_active");
    expect(active.cachedIntent).toBe("order");
  });

  it("answers order field in same utterance as tracking completion", () => {
    const session = mockSession(callSid);
    const gate = resolveTrackingPhaseGate(
      "I wrote it down correctly, now tell me the product title on my order",
      session,
    );
    expect(gate.handled).toBe(true);
    expect(gate.speech).toMatch(/Sample Book|product/i);
    expect(gate.intentKey).toBe("order_field_query");
  });

  it("does not restart notepad after tracking complete when caller asks product totals", () => {
    completeTrackingDictation(callSid);
    const session = mockSession(callSid);
    const gate = resolveTrackingPhaseGate(
      "tell me what is the total order number, how many products, their price, and shipping fee",
      session,
    );
    expect(gate.handled).toBe(false);
    expect(gate.speech).toBeUndefined();
    const active = getOrCreateActiveSession(callSid);
    expect(active.trackingDictationComplete).toBe(true);
    expect(active.currentState).toBe("order_active");
    expect(active.lastSpokenPayload?.trackingForTts).toBeUndefined();

    const fieldSpeech = buildOrderFieldQuerySpeech(
      "how many products, their price, and shipping fee",
      session.currentOrderData as any,
    );
    expect(fieldSpeech).toMatch(/1 book|Sample Book/i);
    expect(fieldSpeech).toMatch(/shipping/i);
  });
});
