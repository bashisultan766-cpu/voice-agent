import { beforeEach, describe, expect, it } from "vitest";
import { resolveTrackingPhaseGate } from "../src/agents/conversationOrchestrator.js";
import { resolveCallerIntent } from "../src/agents/callerIntent.js";
import {
  beginTrackingDictationAfterNotepadReady,
  isUserNotepadReadyIntent,
} from "../src/agents/dictationTool.js";
import { getOrCreateActiveSession, updateActiveSession, ensureTrackingPayload } from "../src/sovereign/activeSession.js";
import type { CallSession } from "../src/types/order.js";

function mockSession(callSid: string): CallSession {
  return {
    callSid,
    from: "+15551234567",
    to: "+15559876543",
    phase: "follow_up",
    greetedThisCall: true,
    currentOrderData: {
      order_number: "#21698-F1",
      customer_name: "Jane Doe",
      tracking_number: "1Z999AA10123456784",
      physical_items: [{ title: "Sample Book", quantity: 1, price: "19.99" }],
    },
    isVerifiedCaller: false,
  } as CallSession;
}

describe("tracking notepad ready handshake", () => {
  const callSid = "CA_notepad_ready_test";

  beforeEach(() => {
    updateActiveSession(callSid, {
      currentState: "order_active",
      cachedIntent: "order",
      trackingDictationComplete: false,
      isNotepadReady: false,
      spatialIndex: [],
    });
    ensureTrackingPayload(callSid, "1Z999AA10123456784");
  });

  it("detects common ready phrases", () => {
    expect(isUserNotepadReadyIntent("okay, I have it ready")).toBe(true);
    expect(isUserNotepadReadyIntent("I am ready")).toBe(true);
    expect(isUserNotepadReadyIntent("I am ready, speak the tracking ID")).toBe(true);
  });

  it("classifies ready phrase as tracking_flow_active even without awaiting_notepad_ready state", () => {
    const session = mockSession(callSid);
    expect(resolveCallerIntent("okay, I have it ready", session)).toBe("tracking_flow_active");
  });

  it("starts dictation when caller says ready after LLM-only notepad prompt", () => {
    const session = mockSession(callSid);
    const gate = resolveTrackingPhaseGate("I am ready, speak the tracking ID", session);
    expect(gate.handled).toBe(true);
    expect(gate.intentKey).toBe("USER_NOTEPAD_READY");
    expect(gate.speech).toMatch(/write that correctly|should I repeat/i);

    const active = getOrCreateActiveSession(callSid);
    expect(active.isNotepadReady).toBe(true);
    expect(active.currentState).toBe("tracking_dictation");
    expect(active.lastSpokenPayload?.trackingForTts).toBeTruthy();
  });

  it("beginTrackingDictationAfterNotepadReady speaks tracking digits", () => {
    const turn = beginTrackingDictationAfterNotepadReady(callSid);
    expect(turn.ok).toBe(true);
    expect(turn.speech.length).toBeGreaterThan(10);
  });
});
