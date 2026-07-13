import { describe, expect, it } from "vitest";
import {
  clearInterruptBuffer,
  isInterruptBufferFull,
  pushInterruptSignal,
  takeInterruptSignal,
} from "../src/runtime/interruptBuffer.js";
import { recordTrackingPayload, updateActiveSession } from "../src/sovereign/activeSession.js";
import { resolveDictateTracking } from "../src/sovereign/dictateTrackingGate.js";
import { resolveTrackingPhaseGate } from "../src/agents/conversationOrchestrator.js";
import type { CallSession } from "../src/types/order.js";

describe("interruptBuffer", () => {
  it("tracks caller speech during agent TTS", () => {
    pushInterruptSignal("CA_INT", "hello");
    expect(isInterruptBufferFull("CA_INT")).toBe(true);
    expect(takeInterruptSignal("CA_INT")).toBe("hello");
    expect(isInterruptBufferFull("CA_INT")).toBe(false);
    clearInterruptBuffer("CA_INT");
  });
});

describe("dictateTrackingGate", () => {
  it("returns ReadinessRequest when notepad is not ready", () => {
    recordTrackingPayload("CA_GATE", "9250");
    const gate = resolveDictateTracking("CA_GATE");
    expect(gate.intent).toBe("ReadinessRequest");
    expect(gate.speech).toMatch(/pen and paper|ready for me to read/i);
  });

  it("dictates tracking only after notepad is ready", () => {
    recordTrackingPayload("CA_GATE2", "9250");
    updateActiveSession("CA_GATE2", { isNotepadReady: true });
    const gate = resolveDictateTracking("CA_GATE2");
    expect(gate.intent).toBe("dictate_tracking");
    expect(gate.speech).toContain("9, 2, 5, 0");
  });
});

describe("sovereignRouter notepad gate", () => {
  it("requires notepad readiness before tracking replay", () => {
    const session = {
      callSid: "CA3",
      from: "+1",
      to: "+2",
      phase: "follow_up",
      orderNumberAttempts: 0,
      createdAt: Date.now(),
      currentOrderData: { tracking_number: "9250" },
    } as CallSession;

    recordTrackingPayload("CA3", "9250");
    const resolution = resolveTrackingPhaseGate("can you repeat my tracking number", session);
    expect(resolution.handled).toBe(true);
    expect(resolution.intentKey).toBe("PHASE_HANDSHAKE");
    expect(resolution.speech).toMatch(/pen and paper|ready for me to read/i);
  });

  it("dictates through gate after caller confirms readiness", () => {
    const session = {
      callSid: "CA4",
      from: "+1",
      to: "+2",
      phase: "follow_up",
      orderNumberAttempts: 0,
      createdAt: Date.now(),
      currentOrderData: { tracking_number: "9250" },
    } as CallSession;

    recordTrackingPayload("CA4", "9250");
    const handshake = resolveTrackingPhaseGate("can you read my tracking number", session);
    expect(handshake.handled).toBe(true);
    expect(handshake.intentKey).toBe("PHASE_HANDSHAKE");

    const resolution = resolveTrackingPhaseGate("yes I am ready", session);
    expect(resolution.handled).toBe(true);
    expect(resolution.intentKey).toBe("USER_NOTEPAD_READY");
    expect(resolution.speech).toContain("9, 2, 5, 0");
  });
});
