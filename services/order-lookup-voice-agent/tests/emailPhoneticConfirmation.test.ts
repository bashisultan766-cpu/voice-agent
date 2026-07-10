import { describe, expect, it } from "vitest";
import {
  buildEmailConfirmationSpeech,
  spellEmailPhoneticForTTS,
} from "../src/utils/emailCapture.js";

describe("phonetic email confirmation speech", () => {
  it("spells local part with letter-as-in cue words", () => {
    const spoken = spellEmailPhoneticForTTS("bash@gmail.com");
    expect(spoken).toMatch(/B as in Boy/i);
    expect(spoken).toMatch(/A as in Apple/i);
    expect(spoken).toMatch(/S as in Sam/i);
    expect(spoken).toMatch(/H as in Henry/i);
    expect(spoken).toMatch(/at gmail dot com/i);
  });

  it("asks for confirmation after phonetic read-back", () => {
    const speech = buildEmailConfirmationSpeech("sam@outlook.com");
    expect(speech).toMatch(/^I have your email as /i);
    expect(speech).toMatch(/S as in Sam/i);
    expect(speech).toMatch(/Is that correct\?$/i);
  });
});
