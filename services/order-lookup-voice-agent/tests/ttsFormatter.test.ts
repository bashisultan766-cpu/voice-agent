import { describe, expect, it } from "vitest";
import {
  clampSsmlBreakTime,
  formatEmailForTTS,
  formatEmailHandleForTTS,
  formatTrackingNumberForTTS,
  parseSsmlBreakTimeMs,
  sanitizeSsmlForTTS,
  sanitizeTextForTTS,
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
  it("inserts safe SSML pauses between every character for slow ElevenLabs dictation", () => {
    const formatted = formatTrackingNumberForTTS("1Z999999999", "slow", { useSsml: true });
    expect(formatted).toBe(
      `1<break time="${SSML_BREAK_SAFE_MS}ms"/>Z<break time="${SSML_BREAK_SAFE_MS}ms"/>9<break time="${SSML_BREAK_SAFE_MS}ms"/>9<break time="${SSML_BREAK_SAFE_MS}ms"/>9<break time="${SSML_BREAK_SAFE_MS}ms"/>9<break time="${SSML_BREAK_SAFE_MS}ms"/>9<break time="${SSML_BREAK_SAFE_MS}ms"/>9<break time="${SSML_BREAK_SAFE_MS}ms"/>9<break time="${SSML_BREAK_SAFE_MS}ms"/>9<break time="${SSML_BREAK_SAFE_MS}ms"/>9<break time="${SSML_BREAK_SAFE_MS}ms"/>`,
    );
  });

  it("uses shorter pauses for normal speed", () => {
    const formatted = formatTrackingNumberForTTS("ABC", "normal", { useSsml: true });
    expect(formatted).toBe('A<break time="500ms"/>B<break time="500ms"/>C<break time="500ms"/>');
  });

  it("uses phonetic punctuation spacing for non-SSML engines", () => {
    const formatted = formatTrackingNumberForTTS("ABC123", "slow", { useSsml: false });
    expect(formatted).toBe("A. , B. , C. , 1. , 2. , 3. ,");
  });

  it("normalizes to uppercase and trims whitespace", () => {
    const formatted = formatTrackingNumberForTTS("  ab-12  ", "slow", { useSsml: true });
    expect(formatted).toContain("A<break");
    expect(formatted).toContain("B<break");
    expect(formatted).not.toContain("  ");
  });

  it("returns empty string for blank input", () => {
    expect(formatTrackingNumberForTTS("   ")).toBe("");
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
