import { describe, expect, it } from "vitest";
import { isNoiseTranscript, cleanTranscriptForNoiseGate } from "../src/utils/noiseGate.js";

describe("noiseGate", () => {
  it("drops empty and very short transcripts", () => {
    expect(isNoiseTranscript("")).toBe(true);
    expect(isNoiseTranscript("  ")).toBe(true);
    expect(isNoiseTranscript("ok")).toBe(true);
    expect(isNoiseTranscript("yes")).toBe(true);
  });

  it("drops common STT fillers", () => {
    expect(isNoiseTranscript("Um.")).toBe(true);
    expect(isNoiseTranscript("Uh.")).toBe(true);
    expect(isNoiseTranscript("Okay.")).toBe(true);
    expect(isNoiseTranscript("hmm")).toBe(true);
  });

  it("allows meaningful speech", () => {
    expect(isNoiseTranscript("where is my order")).toBe(false);
    expect(isNoiseTranscript("9783161484100")).toBe(false);
    expect(isNoiseTranscript("Harry Potter")).toBe(false);
  });

  it("allows short numeric DTMF when configured", () => {
    expect(isNoiseTranscript("5", { allowShortNumeric: true })).toBe(false);
    expect(isNoiseTranscript("5")).toBe(true);
  });

  it("normalizes whitespace", () => {
    expect(cleanTranscriptForNoiseGate("  hello   world  ")).toBe("hello world");
  });
});
