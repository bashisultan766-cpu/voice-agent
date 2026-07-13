import { describe, expect, it } from "vitest";
import {
  clampSsmlBreakTime,
  formatEmailForTTS,
  formatEmailHandleForTTS,
  formatTrackingNumberForTTS,
  formatTrackingRemainderAfterAnchor,
  parseSsmlBreakTimeMs,
  sanitizeSsmlForTTS,
  sanitizeTextForTTS,
  sanitizeTrackingDictationSpeech,
  SSML_BREAK_MAX_MS,
  SSML_BREAK_SAFE_MS,
} from "../src/utils/ttsFormatter.js";

describe("formatEmailHandleForTTS", () => {
  it("returns voice-friendly handle without domain or trailing digits", () => {
    expect(formatEmailHandleForTTS("jamaicathompson87@gmail.com")).toBe("jamaicathompson");
  });

  it("returns null for missing email", () => {
    expect(formatEmailHandleForTTS(null)).toBeNull();
    expect(formatEmailHandleForTTS("")).toBeNull();
  });
});

describe("formatEmailForTTS", () => {
  it("speaks full email for refund notification readout", () => {
    expect(formatEmailForTTS("jamaicathompson87@gmail.com")).toBe(
      "jamaicathompson87 at gmail dot com",
    );
    expect(formatEmailForTTS("btazp@yahoo.com")).toBe("btazp at yahoo dot com");
  });
});

describe("formatTrackingNumberForTTS", () => {
  it("uses comma+space digit pacing for dictation", () => {
    const formatted = formatTrackingNumberForTTS("9250");
    expect(formatted).toBe("9, 2, 5, 0");
  });

  it("comma-paces every character in long alphanumeric tracking IDs", () => {
    const formatted = formatTrackingNumberForTTS("1Z999999999", "slow");
    expect(formatted).toBe("1, Z, 9, 9, 9, 9, 9, 9, 9, 9, 9");
    expect(formatted).not.toContain("<break");
    expect(formatted).not.toMatch(/\d\s+-\s+\d/);
  });

  it("supports legacy SSML opt-in when explicitly requested", () => {
    const formatted = formatTrackingNumberForTTS("ABC", "normal", { useSsml: true });
    expect(formatted).toBe('A<break time="500ms"/>B<break time="500ms"/>C<break time="500ms"/>');
  });

  it("normalizes to uppercase and strips dashes (zero punctuation)", () => {
    const formatted = formatTrackingNumberForTTS("  ab-12  ", "slow");
    expect(formatted).toBe("A, B, 1, 2");
  });

  it("returns empty string for blank input", () => {
    expect(formatTrackingNumberForTTS("   ")).toBe("");
  });

  it("slices remainder after an anchor for what-comes-after precision", () => {
    expect(formatTrackingRemainderAfterAnchor("944901188300", "4490")).toBe("1, 1, 8, 8, 3, 0, 0");
  });
});

describe("sanitizeSsmlForTTS", () => {
  it("clamps dangerously long LLM-generated breaks to 1s max", () => {
    const llmOutput =
      'Your tracking number is 1<break time="5000ms"/>Z<break time="3s"/>9<break time="2000ms"/>';
    const sanitized = sanitizeSsmlForTTS(llmOutput);
    expect(sanitized).toContain('<break time="1s"/>');
    expect(sanitized).not.toContain("5000ms");
    expect(sanitized).not.toContain('time="3s"');
    expect(sanitized).not.toContain("2000ms");
  });

  it("preserves safe sub-1s breaks unchanged", () => {
    const input = '1<break time="800ms"/>Z<break time="500ms"/>';
    expect(sanitizeSsmlForTTS(input)).toBe(input);
  });

  it("sanitizes via sanitizeTextForTTS entry point", () => {
    expect(sanitizeTextForTTS('  1<break time="10s"/>  ')).toBe('1<break time="1s"/>');
  });

  it("rewrites point-decimal tracking speech into comma-paced digits", () => {
    expect(sanitizeTrackingDictationSpeech("After 47, the digits are: point 02")).toBe(
      "After 47, the digits are: 0, 2",
    );
    expect(sanitizeTrackingDictationSpeech("point zero two")).toBe("0, 2");
  });
});

describe("parseSsmlBreakTimeMs", () => {
  it("parses ms, seconds, and bare numeric values", () => {
    expect(parseSsmlBreakTimeMs("500ms")).toBe(500);
    expect(parseSsmlBreakTimeMs("2s")).toBe(2000);
    expect(parseSsmlBreakTimeMs("1.5s")).toBe(1500);
  });
});

describe("clampSsmlBreakTime", () => {
  it("never exceeds SSML_BREAK_MAX_MS", () => {
    expect(clampSsmlBreakTime("5000ms")).toBe("1s");
    expect(clampSsmlBreakTime("750ms")).toBe("750ms");
    expect(parseSsmlBreakTimeMs(clampSsmlBreakTime("5000ms"))).toBeLessThanOrEqual(SSML_BREAK_MAX_MS);
  });
});
