import { describe, expect, it } from "vitest";
import {
  buildSpatialIndexFromTracking,
  createActiveSession,
  ensureTrackingPayload,
  recordTrackingPayload,
  shouldSkipToolReinvoke,
  syncActiveSessionFromCallSession,
  updateActiveSession,
} from "../src/sovereign/activeSession.js";
import {
  buildSpatialResumeSpeech,
  extractSpatialAnchorDigits,
} from "../src/sovereign/spatialDictation.js";
import { resolveTrackingPhaseGate } from "../src/agents/conversationOrchestrator.js";
import type { CallSession } from "../src/types/order.js";

describe("activeSession spatial index", () => {
  it("builds digit-only spatial index (letters stripped from carrier IDs)", () => {
    expect(buildSpatialIndexFromTracking("1Z39")).toEqual([
      { index: 0, digit: "1" },
      { index: 1, digit: "3" },
      { index: 2, digit: "9" },
    ]);
  });

  it("records tracking payload with phonetic pacing", () => {
    const active = recordTrackingPayload("CA1", "925");
    expect(active.currentState).toBe("awaiting_notepad_ready");
    expect(active.lastSpokenPayload?.trackingForTts).toBe("9, 2, 5");
    expect(active.spatialIndex).toHaveLength(3);
  });

  it("skips tool reinvoke when intent is cached", () => {
    recordTrackingPayload("CA2", "9250");
    const active = ensureTrackingPayload("CA2", "9250");
    expect(shouldSkipToolReinvoke(active, "tracking", "get_shopify_order_status")).toBe(true);
    expect(shouldSkipToolReinvoke(active, "order", "get_shopify_order_status")).toBe(false);
  });

  it("ensureTrackingPayload preserves notepad progress on sync", () => {
    recordTrackingPayload("CA_SYNC", "9250");
    updateActiveSession("CA_SYNC", { isNotepadReady: true, currentState: "tracking_dictation", lastSpokenIndex: 2 });

    const session = {
      callSid: "CA_SYNC",
      from: "+1",
      to: "+2",
      phase: "follow_up",
      orderNumberAttempts: 0,
      createdAt: Date.now(),
      currentOrderData: { tracking_number: "9250" },
    } as CallSession;

    const after = syncActiveSessionFromCallSession(session);
    expect(after.isNotepadReady).toBe(true);
    expect(after.currentState).toBe("tracking_dictation");
    expect(after.lastSpokenIndex).toBe(2);
  });
});

describe("spatialDictation", () => {
  it("extracts anchor digits from 3-9 style queries", () => {
    expect(extractSpatialAnchorDigits("what comes after 3-9")).toEqual(["3", "9"]);
  });

  it("resumes dictation after latest anchor", () => {
    const index = buildSpatialIndexFromTracking("139415");
    const speech = buildSpatialResumeSpeech(index, ["3", "9"], "139415");
    expect(speech).toMatch(/the digits are/i);
    expect(speech).toMatch(/Four\./);
  });
});

describe("tracking phase gate", () => {
  it("replays tracking from ActiveSession without tools", () => {
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
    expect(resolution.skipTools).toBe(true);
    expect(resolution.speech).toMatch(/pen and paper|ready for me to read|pen and notepad/i);
  });
});
