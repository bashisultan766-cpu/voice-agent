import { describe, expect, it } from "vitest";
import {
  buildEmailConfirmationSpeech,
  spellEmailLetterByLetterForTTS,
} from "../src/utils/emailCapture.js";

describe("letter-by-letter email confirmation speech", () => {
  it("spells local part letter-by-letter without phonetic cue words", () => {
    const spoken = spellEmailLetterByLetterForTTS("bash@gmail.com");
    expect(spoken).toMatch(/^B, A, S, H at gmail dot com$/i);
    expect(spoken).not.toMatch(/as in/i);
  });

  it("asks for confirmation after letter-by-letter read-back", () => {
    const speech = buildEmailConfirmationSpeech("sam@outlook.com");
    expect(speech).toMatch(/^I have your email as /i);
    expect(speech).toMatch(/S, A, M at outlook dot com/i);
    expect(speech).not.toMatch(/as in/i);
    expect(speech).toMatch(/Is that correct\?$/i);
  });
});
