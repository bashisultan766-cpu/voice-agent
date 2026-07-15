import { describe, expect, it } from "vitest";
import {
  brandProfile,
  buildBrandProfileKnowledgeBlock,
  MAILCALL_ABOUT_US,
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

  it("contains the authoritative About Us purpose and sections", () => {
    expect(MAILCALL_ABOUT_US.pageCount).toBe(24);
    expect(MAILCALL_ABOUT_US.mission).toContain("educate, entertain, and empower");
    expect(MAILCALL_ABOUT_US.vision).toContain("informs but also inspires");
    expect(MAILCALL_ABOUT_US.sections).toContain("Inmate News & Sentencing Updates");
    expect(MAILCALL_ABOUT_US.sections).toContain("Spanish Content & Travel");

    const knowledge = buildBrandProfileKnowledgeBlock();
    expect(knowledge).toContain("Celebrity Gossip & Real News");
    expect(knowledge).toContain("Your Connection. Your Community. Your Voice.");
  });

  it("answers purpose, values, and content questions from About Us", () => {
    expect(matchBrandProfileQuery("What is your mission?")).toContain(
      "educate, entertain, and empower",
    );
    expect(matchBrandProfileQuery("What are your values?")).toContain(
      "Thousands of inmates",
    );
    expect(matchBrandProfileQuery("What sections are inside the newspaper?")).toContain(
      "twenty-four-page edition",
    );
  });

  it("offline fallback never uses technical jargon", () => {
    const speech = brandOfflineFallbackSpeech("latest headlines please");
    expect(speech).not.toMatch(/api|wordpress|error|server|database|timeout/i);
    expect(speech.toLowerCase()).toContain("mail call");
  });
});
