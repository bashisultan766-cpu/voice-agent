import { describe, expect, it } from "vitest";
import {
  buildTrackingDictationChunks,
  calculateResumeOffset,
  TRACKING_DICTATION_CHUNK_SIZE,
} from "../src/agents/dictationTool.js";
import { buildSpatialIndexFromTracking } from "../src/sovereign/activeSession.js";

describe("dictationTool", () => {
  it("chunks tracking into groups of four digits", () => {
    const index = buildSpatialIndexFromTracking("12345678");
    const chunks = buildTrackingDictationChunks(index, 0, TRACKING_DICTATION_CHUNK_SIZE);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].dictationEndIndex).toBe(3);
    expect(chunks[1].dictationEndIndex).toBe(7);
    expect(chunks[0].pauseMs).toBeGreaterThan(0);
    expect(chunks[1].pauseMs).toBe(0);
  });

  it("calculates spatial resume offset after anchor digits", () => {
    const index = buildSpatialIndexFromTracking("139415");
    const offset = calculateResumeOffset(index, ["3", "9"]);
    expect(offset).toBe(3);
  });
});
