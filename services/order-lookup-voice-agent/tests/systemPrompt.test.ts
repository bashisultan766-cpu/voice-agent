import { describe, expect, it } from "vitest";
import { SHOSHAN_SYSTEM_PROMPT } from "../src/prompts/systemPrompt.js";

describe("SHOSHAN_SYSTEM_PROMPT anti-hallucination", () => {
  it("forbids inventing order data when tool returns NOT_FOUND", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CRITICAL ANTI-HALLUCINATION RULE/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/"status": "NOT_FOUND"/);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /I apologize, but I cannot find an order matching that number in our system/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NEVER invent, guess, or create fake customer names/i);
  });

  it("requires full order S.O.P. fields when data is found", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Customer Name/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/order_placed_at/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CHRONOLOGICAL DATA RULE/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/never truncate or shorten/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/refund_date/i);
  });
});
