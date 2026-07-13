import { describe, expect, it, beforeEach } from "vitest";
import {
  clearActiveSession,
  ensureTrackingPayload,
  getOrCreateActiveSession,
  buildSlowerTrackingReplaySpeech,
  updateActiveSession,
} from "../src/sovereign/activeSession.js";
import {
  promptUserForNotepad,
  TRACKING_DICTATION_CONFIRM_SPEECH,
  appendTrackingDictationConfirm,
  beginTrackingDictationAfterNotepadReady,
} from "../src/agents/dictationTool.js";
import {
  formatTrackingNumberForTTS,
  formatTrackingNumberForTTSSlower,
} from "../src/utils/ttsFormatter.js";
import { isContextualDictationRepeatRequest } from "../src/agents/trackingIntent.js";
import { extractTrackingFromOrderNote } from "../src/adapters/orderFieldExtractors.js";
import { SHOSHAN_SYSTEM_PROMPT } from "../src/prompts/systemPrompt.js";
import { resolveTrackingPhaseGate } from "../src/agents/conversationOrchestrator.js";
import type { CallSession } from "../src/types/order.js";

const CALL_SID = "CA_data_dictation_protocol";

function baseSession(overrides: Partial<CallSession> = {}): CallSession {
  return {
    callSid: CALL_SID,
    phase: "active",
    orderContextConfirmed: true,
    currentOrderData: {
      tracking_number: "9400111899223344556677",
      order_number: "12345",
    },
    shoppingCart: [],
    ...overrides,
  } as CallSession;
}

describe("Data Dictation Protocol", () => {
  beforeEach(() => {
    clearActiveSession(CALL_SID);
  });

  it("system prompt includes notepad check, comma TTS, and contextual repeat rules", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/DATA DICTATION PROTOCOL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /I have your tracking number right here\. Let me know when you have a pen and paper ready/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/9, 4, 4, 9, 0, 1/);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /Did you get all that, or should I repeat any part of it/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/lastSpokenDataPoint/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/orderNote \/ note/i);
  });

  it("formats digit tracking with commas between every character", () => {
    expect(formatTrackingNumberForTTS("944901")).toBe("9, 4, 4, 9, 0, 1");
    expect(formatTrackingNumberForTTSSlower("944901")).toBe("9,  4,  4,  9,  0,  1");
  });

  it("uses phonetic comma pacing for alphanumeric tracking IDs", () => {
    expect(formatTrackingNumberForTTS("1Z999")).toBe("One, Z, Nine, Nine, Nine");
  });

  it("notepad handshake uses the Data Dictation Protocol script", () => {
    expect(promptUserForNotepad()).toMatch(/tracking number right here/i);
    expect(promptUserForNotepad()).toMatch(/pen and paper ready/i);
    expect(TRACKING_DICTATION_CONFIRM_SPEECH).toMatch(/Did you get all that/i);
  });

  it("extracts tracking digits from orderNote text", () => {
    expect(
      extractTrackingFromOrderNote("Account note — Tracking Number: 9400111899223344556677"),
    ).toBe("9400111899223344556677");
    expect(extractTrackingFromOrderNote("No tracking here")).toBeUndefined();
  });

  it("detects contextual repeat / slower requests", () => {
    expect(isContextualDictationRepeatRequest("can you repeat that")).toBe(true);
    expect(isContextualDictationRepeatRequest("say it slower")).toBe(true);
    expect(isContextualDictationRepeatRequest("one more time")).toBe(true);
    expect(isContextualDictationRepeatRequest("what is the tracking number")).toBe(false);
  });

  it("retains lastSpokenDataPoint and replays only tracking on say it slower", () => {
    ensureTrackingPayload(CALL_SID, "9400111899223344556677");
    updateActiveSession(CALL_SID, { isNotepadReady: true, currentState: "tracking_dictation" });
    const dictated = beginTrackingDictationAfterNotepadReady(CALL_SID);
    expect(dictated.ok).toBe(true);
    expect(dictated.speech).toMatch(/9, 4, 0/);
    expect(dictated.speech).toContain(TRACKING_DICTATION_CONFIRM_SPEECH);

    const active = getOrCreateActiveSession(CALL_SID);
    expect(active.lastSpokenDataPoint?.kind).toBe("tracking_number");
    expect(active.lastSpokenDataPoint?.raw).toBe("9400111899223344556677");

    const session = baseSession();
    const repeat = resolveTrackingPhaseGate("say it slower please", session);
    expect(repeat.handled).toBe(true);
    expect(repeat.speech).toContain("9,  4");
    expect(repeat.speech).not.toMatch(/physical_items|shipping_amount|full summary/i);
    expect(appendTrackingDictationConfirm(repeat.speech ?? "")).toMatch(/get all that/i);

    const slower = buildSlowerTrackingReplaySpeech(CALL_SID);
    expect(slower).toContain("9,  4");
  });

  it("does not dump order payload when repeating during notepad wait", () => {
    ensureTrackingPayload(CALL_SID, "9400111899223344556677");
    const session = baseSession();
    const repeat = resolveTrackingPhaseGate("repeat that", session);
    expect(repeat.handled).toBe(true);
    expect(repeat.speech).toMatch(/pen and paper ready/i);
    expect(repeat.speech).not.toMatch(/9, 4/);
  });
});
