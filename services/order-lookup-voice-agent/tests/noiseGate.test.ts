import { describe, it, expect } from "vitest";
import {
  isNoiseTranscript,
  cleanTranscriptForNoiseGate,
  isShortConfirmationTranscript,
  shouldPromptAreYouStillThere,
} from "../src/utils/noiseGate.js";

describe("noiseGate", () => {
  it("drops empty and tiny fillers", () => {
    expect(isNoiseTranscript("")).toBe(true);
    expect(isNoiseTranscript("  ")).toBe(true);
    expect(isNoiseTranscript("ok")).toBe(true);
    expect(isNoiseTranscript("yes")).toBe(true);
  });

  it("drops common filler words with punctuation", () => {
    expect(isNoiseTranscript("Um.")).toBe(true);
    expect(isNoiseTranscript("Uh.")).toBe(true);
    expect(isNoiseTranscript("Okay.")).toBe(true);
    expect(isNoiseTranscript("hmm")).toBe(true);
  });

  it("keeps real speech", () => {
    expect(isNoiseTranscript("where is my order")).toBe(false);
    expect(isNoiseTranscript("9783161484100")).toBe(false);
    expect(isNoiseTranscript("Harry Potter")).toBe(false);
  });

  it("allows short numeric when opted in", () => {
    expect(isNoiseTranscript("5", { allowShortNumeric: true })).toBe(false);
    expect(isNoiseTranscript("5")).toBe(true);
  });

  it("normalizes whitespace for gating", () => {
    expect(cleanTranscriptForNoiseGate("  hello   world  ")).toBe("hello world");
  });

  it("lets short confirmations through the still-there gate", () => {
    expect(isShortConfirmationTranscript("yes")).toBe(true);
    expect(shouldPromptAreYouStillThere("yes")).toBe(false);
    expect(shouldPromptAreYouStillThere("cough")).toBe(true);
  });
});
