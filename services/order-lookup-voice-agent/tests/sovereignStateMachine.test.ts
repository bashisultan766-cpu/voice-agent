import { describe, expect, it } from "vitest";
import {
  buildSpatialIndexFromTracking,
  createActiveSession,
  recordTrackingPayload,
  shouldSkipToolReinvoke,
} from "../src/sovereign/activeSession.js";
import {
  buildSpatialResumeSpeech,
  extractSpatialAnchorDigits,
} from "../src/sovereign/spatialDictation.js";
import { resolveSovereignTurn } from "../src/sovereign/sovereignRouter.js";
import type { CallSession } from "../src/types/order.js";

describe("activeSession spatial index", () => {
  it("builds index entries for each tracking character", () => {
    expect(buildSpatialIndexFromTracking("1Z39")).toEqual([
      { index: 0, digit: "1" },
      { index: 1, digit: "Z" },
      { index: 2, digit: "3" },
      { index: 3, digit: "9" },
    ]);
  });

  it("records tracking payload with phonetic pacing", () => {
    const active = recordTrackingPayload("CA1", "925");
    expect(active.currentState).toBe("tracking_dictation");
    expect(active.lastSpokenPayload?.trackingForTts).toBe("Nine. Two. Five.");
    expect(active.spatialIndex).toHaveLength(3);
  });

  it("skips tool reinvoke when intent is cached", () => {
    recordTrackingPayload("CA2", "9250");
    const active = recordTrackingPayload("CA2", "9250");
    expect(shouldSkipToolReinvoke(active, "tracking", "get_shopify_order_status")).toBe(true);
    expect(shouldSkipToolReinvoke(active, "order", "get_shopify_order_status")).toBe(false);
  });
});

describe("spatialDictation", () => {
  it("extracts anchor digits from 3-9 style queries", () => {
    expect(extractSpatialAnchorDigits("what comes after 3-9")).toEqual(["3", "9"]);
  });

  it("resumes dictation after latest anchor", () => {
    const index = buildSpatialIndexFromTracking("139415");
    const speech = buildSpatialResumeSpeech(index, ["3", "9"], "139415");
    expect(speech).toMatch(/following digits are/i);
    expect(speech).toMatch(/Four\./);
  });
});

describe("sovereignRouter", () => {
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
    const resolution = resolveSovereignTurn("can you repeat my tracking number", session);
    expect(resolution.handled).toBe(true);
    expect(resolution.skipTools).toBe(true);
    expect(resolution.speech).toBe("Nine. Two. Five. Zero.");
  });
});
