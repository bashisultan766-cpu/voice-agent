import { describe, expect, it, beforeEach } from "vitest";
import {
  resolveCallerIntent,
  isIntentSwitchAwayFromTracking,
  isSupportEscalationRequest,
} from "../src/agents/callerIntent.js";
import { resolveTrackingPhaseGate } from "../src/agents/conversationOrchestrator.js";
import { getOrCreateActiveSession, updateActiveSession } from "../src/sovereign/activeSession.js";
import type { CallSession } from "../src/types/order.js";

function mockSession(callSid: string): CallSession {
  return {
    callSid,
    from: "+15551234567",
    to: "+15559876543",
    phase: "follow_up",
    greetedThisCall: true,
    currentOrderData: {
      order_number: "21698",
      customer_name: "Jane Doe",
      tracking_number: "1Z999AA10123456784",
      physical_items: [{ title: "Sample Book", quantity: 1, price: "19.99" }],
    },
    isVerifiedCaller: false,
  } as CallSession;
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
});
