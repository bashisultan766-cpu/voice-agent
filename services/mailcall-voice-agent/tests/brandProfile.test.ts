import { describe, expect, it } from "vitest";
import {
  brandProfile,
  matchBrandProfileQuery,
  brandOfflineFallbackSpeech,
} from "../src/agents/mailcall/brandProfile.js";

describe("brandProfile", () => {
  it("matches identity and location questions", () => {
    expect(matchBrandProfileQuery("What is Mail Call Communication?")?.toLowerCase()).toContain(
      "news",
    );
    expect(matchBrandProfileQuery("Where are you located?")).toContain(
      "650 East Palisade Ave #429",
    );
  });

  it("exports the authoritative U.S. corporate profile", () => {
    expect(brandProfile).toEqual({
      name: "MailCall Newspaper",
      ceo: "Staff Management",
      address: "650 East Palisade Ave #429, Englewood Cliffs, New Jersey 07632",
      phone: "201.429.0422",
      email: "support@mailcallnewspaper.com",
      mission: "Keeping Inmates Connected, Informed & Empowered.",
    });
  });

  it("offline fallback never uses technical jargon", () => {
    const speech = brandOfflineFallbackSpeech("latest headlines please");
    expect(speech).not.toMatch(/api|wordpress|error|server|database|timeout/i);
    expect(speech.toLowerCase()).toContain("mail call");
  });
});
