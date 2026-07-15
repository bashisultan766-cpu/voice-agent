import { describe, expect, it } from "vitest";
import {
  cleanseForSpeech,
  truncateToSentences,
  clampSpokenLength,
  normalizeVoiceTranscript,
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

  it("removes scripts, styles, comments, and visual shortcode markers", () => {
    const raw =
      '<script>window.secret = "never speak this"</script>' +
      "<style>.hero { display:none }</style>" +
      "<!-- private note --><p>Visible office details.</p>[gallery id=\"9\"]";
    const cleaned = cleanseForSpeech(raw);
    expect(cleaned).toBe("Visible office details.");
    expect(cleaned).not.toMatch(/window|secret|display|gallery|private note/i);
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

describe("normalizeVoiceTranscript", () => {
  it("repairs common MailCall STT mis-hears", () => {
    expect(normalizeVoiceTranscript("I called about the medical newspaper")).toContain(
      "MailCall Newspaper",
    );
    expect(normalizeVoiceTranscript("male communication please")).toContain("MailCall Newspaper");
    expect(normalizeVoiceTranscript("mail communication support")).toContain("MailCall Newspaper");
  });
});
