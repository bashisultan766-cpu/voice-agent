import { describe, expect, it } from "vitest";
import {
  cleanseForSpeech,
  truncateToSentences,
  clampSpokenLength,
} from "../src/agents/mailcall/textCleaner.js";

describe("cleanseForSpeech", () => {
  it("strips HTML tags and entities", () => {
    const raw = "<p>Hello&nbsp;<strong>world</strong> &amp; friends</p>";
    expect(cleanseForSpeech(raw)).toBe("Hello world & friends");
  });

  it("strips shortcodes and markdown links without reading URLs", () => {
    const raw =
      'Read [this](https://example.com/long/path) [caption id="1"]photo[/caption] now';
    expect(cleanseForSpeech(raw)).toBe("Read this photo now");
  });

  it("removes bare URLs", () => {
    expect(cleanseForSpeech("See https://mailcall.example/post-1 for more.")).toBe(
      "See for more.",
    );
  });
});

describe("truncateToSentences", () => {
  it("keeps at most three sentences", () => {
    const text =
      "One. Two. Three. Four should be dropped. Five also.";
    expect(truncateToSentences(text, 3)).toBe("One. Two. Three.");
  });
});

describe("clampSpokenLength", () => {
  it("limits word count for TTS", () => {
    const words = Array.from({ length: 80 }, (_, i) => `w${i}`).join(" ");
    const out = clampSpokenLength(words, 10);
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(11);
    expect(out.endsWith(".")).toBe(true);
  });
});
