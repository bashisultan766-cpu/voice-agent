import { describe, expect, it } from "vitest";
import { buildSpatialIndexFromTracking } from "../src/sovereign/activeSession.js";
import {
  extractSpatialAnchorDigits,
  resolveSpatialTurnSpeech,
} from "../src/sovereign/spatialDictation.js";
import { resolveTrackingPhaseGate } from "../src/agents/conversationOrchestrator.js";
import { recordTrackingPayload, updateActiveSession, getOrCreateActiveSession } from "../src/sovereign/activeSession.js";
import { isTrackingRequest, isTrackingDictationCompleteIntent } from "../src/agents/trackingIntent.js";
import { saveActiveOrderContext } from "../src/agents/sessionManager.js";
import type { CallSession } from "../src/types/order.js";

function trackingSession(callSid: string, trackingNumber: string): CallSession {
  const session = {
    callSid,
    from: "+1",
    to: "+2",
    phase: "follow_up",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
  } as CallSession;
  saveActiveOrderContext(session, { tracking_number: trackingNumber });
  return session;
}

describe("spatialDictation anchors", () => {
  const tracking = ":9449050105795009634765";
  const spatialIndex = buildSpatialIndexFromTracking(tracking);

  it("extracts comma-separated anchors like 3,9", () => {
    expect(extractSpatialAnchorDigits("what comes after 3,9")).toEqual(["3", "9"]);
  });

  it("extracts anchors with spoken 'and' between digits", () => {
    expect(extractSpatialAnchorDigits("what comes after 3 and 5")).toEqual(["3", "5"]);
    expect(extractSpatialAnchorDigits("please repeat after 5, 3")).toEqual(["5", "3"]);
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

  it("speaks digit words only after spatial anchor — never decimal points", () => {
    const localTracking = "9904530123";
    const localIndex = buildSpatialIndexFromTracking(localTracking);
    const turn = resolveSpatialTurnSpeech("what comes after 45", localIndex, localTracking);
    expect(turn.handled).toBe(true);
    expect(turn.speech).toMatch(/Three\./i);
    expect(turn.speech).not.toMatch(/3\.0|point/i);
  });

  it("resumes after 47 with leading-zero digits spoken phonetically", () => {
    const localTracking = "9904702123";
    const localIndex = buildSpatialIndexFromTracking(localTracking);
    const turn = resolveSpatialTurnSpeech("what comes after 47?", localIndex, localTracking);
    expect(turn.handled).toBe(true);
    expect(turn.speech).toMatch(/Zero\.\s*Two\./i);
    expect(turn.speech).not.toMatch(/point/i);
    expect(turn.resumeOffset).toBe(5);
  });

  it("parses spoken point between anchor digits without decimal math", () => {
    expect(extractSpatialAnchorDigits("what comes after 4 point 7")).toEqual(["4", "7"]);
  });
});

describe("tracking dictation completion", () => {
  it("does not treat written-down confirmation as a new tracking request", () => {
    expect(isTrackingRequest("I have written down the tracking ID correctly")).toBe(false);
    expect(isTrackingDictationCompleteIntent("I have written down the tracking ID correctly")).toBe(
      true,
    );
  });

  it("treats confirmations as completion even if the word repeat is used", () => {
    expect(
      isTrackingDictationCompleteIntent("I repeat your ID. I wrote it down correctly.", {
        currentState: "tracking_dictation",
        lastSpokenIndex: 2,
      }),
    ).toBe(true);
  });

  it("does not treat bare thanks as completion during notepad handshake", () => {
    expect(
      isTrackingDictationCompleteIntent("thanks", {
        currentState: "awaiting_notepad_ready",
        lastSpokenIndex: -1,
      }),
    ).toBe(false);
    expect(
      isTrackingDictationCompleteIntent("thank you", {
        currentState: "tracking_dictation",
        lastSpokenIndex: -1,
      }),
    ).toBe(false);
  });

  it("exits notepad handshake to LLM on unrelated thanks (no nudge loop)", () => {
    const session = trackingSession("CA_THANKS", "9250");

    recordTrackingPayload("CA_THANKS", "9250");
    const resolution = resolveTrackingPhaseGate("thanks", session);
    expect(resolution.handled).toBe(false);
  });

  it("closes tracking flow instead of restarting dictation", () => {
    const session = trackingSession("CA_DONE", "9449050105795009634765");

    recordTrackingPayload("CA_DONE", "9449050105795009634765");
    updateActiveSession("CA_DONE", { isNotepadReady: true, currentState: "tracking_dictation" });

    const resolution = resolveTrackingPhaseGate(
      "ok done I have written it down thank you",
      session,
    );
    expect(resolution.handled).toBe(true);
    expect(resolution.intentKey).toBe("tracking_complete");
    expect(resolution.speech).toMatch(/how else can I help you today/i);
    expect(resolution.speech).not.toMatch(/Nine\./);

    const after = getOrCreateActiveSession("CA_DONE");
    expect(after.currentState).toBe("order_active");
    expect(after.isNotepadReady).toBe(false);
  });
});

describe("tracking gate shorthand", () => {
  it("requires notepad before reading tracking for give me the id", () => {
    const session = trackingSession("CA_ID", "9449050105795009634765");

    recordTrackingPayload("CA_ID", "9449050105795009634765");
    const resolution = resolveTrackingPhaseGate("give me the id number", session);
    expect(resolution.handled).toBe(true);
    expect(resolution.intentKey).toBe("PHASE_HANDSHAKE");
    expect(resolution.speech).toMatch(/pen and paper|ready for me to read|pen and notepad/i);
  });

  it("handles spatial queries through the orchestrator gate", () => {
    const session = trackingSession("CA_SPATIAL", "9449050105795009634765");

    recordTrackingPayload("CA_SPATIAL", "9449050105795009634765");
    updateActiveSession("CA_SPATIAL", {
      isNotepadReady: true,
      currentState: "tracking_dictation",
      cachedIntent: "tracking",
    });

    const resolution = resolveTrackingPhaseGate("what comes after 6,3", session);
    expect(resolution.handled).toBe(true);
    expect(resolution.intentKey).toBe("spatial_resume");
    expect(resolution.speech).toMatch(/After Six-Three/i);
    expect(resolution.speech).not.toMatch(/pen and (?:notepad|paper)|ready for me to read/i);
  });

  it("does not restart notepad handshake on spatial query mid-dictation", () => {
    const session = trackingSession("CA_SPATIAL2", "9449050105795009634765");

    recordTrackingPayload("CA_SPATIAL2", "9449050105795009634765");
    updateActiveSession("CA_SPATIAL2", {
      isNotepadReady: true,
      currentState: "tracking_dictation",
      cachedIntent: "tracking",
      lastSpokenIndex: 4,
    });

    const resolution = resolveTrackingPhaseGate("what comes after 4.5", session);
    expect(resolution.handled).toBe(true);
    expect(resolution.intentKey).toBe("spatial_resume");
    expect(resolution.speech).not.toMatch(/pen and (?:notepad|paper)|let me know when you are ready|ready for me to read/i);
    expect(resolution.speech).not.toMatch(/3\.0|point/i);

    const active = getOrCreateActiveSession("CA_SPATIAL2");
    expect(active.currentState).toBe("tracking_dictation");
    expect(active.isNotepadReady).toBe(true);
  });
});
