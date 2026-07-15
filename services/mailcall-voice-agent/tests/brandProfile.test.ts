import { describe, expect, it } from "vitest";
import {
  matchBrandProfileQuery,
  brandOfflineFallbackSpeech,
  BRAND_LOCATION,
} from "../src/agents/mailcall/brandProfile.js";

describe("brandProfile", () => {
  it("matches identity and location questions", () => {
    expect(matchBrandProfileQuery("What is Mail Call Communication?")?.toLowerCase()).toContain(
      "news",
    );
    expect(matchBrandProfileQuery("Where are you located?")?.toLowerCase()).toContain(
      BRAND_LOCATION.split(",")[0]!.toLowerCase(),
    );
  });

  it("offline fallback never uses technical jargon", () => {
    const speech = brandOfflineFallbackSpeech("latest headlines please");
    expect(speech).not.toMatch(/api|wordpress|error|server|database|timeout/i);
    expect(speech.toLowerCase()).toContain("mail call");
  });
});
