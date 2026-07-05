import { describe, expect, it } from "vitest";
import { formatTrackingNumberForTTS } from "../src/utils/ttsFormatter.js";

describe("formatTrackingNumberForTTS", () => {
  it("inserts SSML pauses between every character for ElevenLabs", () => {
    const formatted = formatTrackingNumberForTTS("1Z999999999", { useSsml: true });
    expect(formatted).toBe(
      "1<break time=\"500ms\"/>Z<break time=\"500ms\"/>9<break time=\"500ms\"/>9<break time=\"500ms\"/>9<break time=\"500ms\"/>9<break time=\"500ms\"/>9<break time=\"500ms\"/>9<break time=\"500ms\"/>9<break time=\"500ms\"/>9<break time=\"500ms\"/>9<break time=\"500ms\"/>",
    );
  });

  it("uses comma spacing between characters for non-SSML engines", () => {
    const formatted = formatTrackingNumberForTTS("ABC123", { useSsml: false });
    expect(formatted).toBe("A , B , C , 1 , 2 , 3 ,");
  });

  it("normalizes to uppercase and trims whitespace", () => {
    const formatted = formatTrackingNumberForTTS("  ab-12  ", { useSsml: true });
    expect(formatted).toContain("A<break");
    expect(formatted).toContain("B<break");
    expect(formatted).not.toContain("  ");
  });

  it("returns empty string for blank input", () => {
    expect(formatTrackingNumberForTTS("   ")).toBe("");
  });
});
