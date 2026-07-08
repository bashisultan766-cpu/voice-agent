import { describe, expect, it } from "vitest";
import { buildSpatialIndexFromTracking } from "../src/sovereign/activeSession.js";
import {
  extractSpatialAnchorDigits,
  resolveSpatialTurnSpeech,
} from "../src/sovereign/spatialDictation.js";
import { resolveTrackingPhaseGate } from "../src/agents/conversationOrchestrator.js";
import { recordTrackingPayload, updateActiveSession } from "../src/sovereign/activeSession.js";
import type { CallSession } from "../src/types/order.js";

describe("spatialDictation anchors", () => {
  const tracking = ":9449050105795009634765";
  const spatialIndex = buildSpatialIndexFromTracking(tracking);

  it("extracts comma-separated anchors like 3,9", () => {
    expect(extractSpatialAnchorDigits("what comes after 3,9")).toEqual(["3", "9"]);
  });

  it("extracts long comma runs and resumes from the matched suffix anchor", () => {
    expect(extractSpatialAnchorDigits("what comes after 7,8,9,3,9")).toEqual([
      "7",
      "8",
      "9",
      "3",
      "9",
    ]);
    const turn = resolveSpatialTurnSpeech("what comes after 6,3", spatialIndex, tracking);
    expect(turn.handled).toBe(true);
    expect(turn.speech).toMatch(/After Six-Three/i);
    expect(turn.speech).not.toMatch(/what comes after/i);
  });

  it("resumes after 0,0,0 without repeating the full tracking number", () => {
    const turn = resolveSpatialTurnSpeech("what comes after 0,0,0", spatialIndex, tracking);
    expect(turn.handled).toBe(true);
    expect(turn.speech).toMatch(/After Zero-Zero-Zero/i);
    expect((turn.speech ?? "").length).toBeLessThan(120);
  });
});

describe("tracking gate shorthand", () => {
  it("requires notepad before reading tracking for give me the id", () => {
    const session = {
      callSid: "CA_ID",
      from: "+1",
      to: "+2",
      phase: "follow_up",
      orderNumberAttempts: 0,
      createdAt: Date.now(),
      currentOrderData: { tracking_number: "9449050105795009634765" },
    } as CallSession;

    recordTrackingPayload("CA_ID", "9449050105795009634765");
    const resolution = resolveTrackingPhaseGate("give me the id number", session);
    expect(resolution.handled).toBe(true);
    expect(resolution.intentKey).toBe("PHASE_HANDSHAKE");
    expect(resolution.speech).toContain("pen and notepad");
  });

  it("handles spatial queries through the orchestrator gate", () => {
    const session = {
      callSid: "CA_SPATIAL",
      from: "+1",
      to: "+2",
      phase: "follow_up",
      orderNumberAttempts: 0,
      createdAt: Date.now(),
      currentOrderData: { tracking_number: "9449050105795009634765" },
    } as CallSession;

    recordTrackingPayload("CA_SPATIAL", "9449050105795009634765");
    updateActiveSession("CA_SPATIAL", { isNotepadReady: true });

    const resolution = resolveTrackingPhaseGate("what comes after 6,3", session);
    expect(resolution.handled).toBe(true);
    expect(resolution.intentKey).toBe("spatial_resume");
    expect(resolution.speech).toMatch(/After Six-Three/i);
  });
});
