import { describe, expect, it } from "vitest";
import {
  conversationalize,
  smoothForVoice,
  splitIntoSmoothedChunks,
} from "../src/services/voiceSmoothingEngine.js";

describe("voiceSmoothingEngine", () => {
  it("conversationalizes order summary phrasing", () => {
    const out = conversationalize("I found your order. It contains 3 items. The total is 42 USD.");
    expect(out).toContain("Great — I found your order.");
    expect(out).toContain("It has 3 items.");
    expect(out).toContain("The total was");
  });

  it("splits into short chunks with micro-pauses", () => {
    const chunks = splitIntoSmoothedChunks(
      "Great — I found your order. It has 3 items. The total was 42 dollars.",
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.pauseMs).toBeGreaterThanOrEqual(80);
    expect(chunks[0]?.pauseMs).toBeLessThanOrEqual(150);
  });

  it("keeps one idea per sentence", () => {
    const out = smoothForVoice("Found order.   Three items.  Total forty-two.");
    expect(out.split(/[.!?]/).filter(Boolean).length).toBeLessThanOrEqual(4);
  });
});
