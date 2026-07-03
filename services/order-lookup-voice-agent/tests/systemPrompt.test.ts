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

  it("requires fluent English and customer_email in proactive template", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/fluent, professional English/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/customer_email/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/PROACTIVE ORDER DELIVERY/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/The email associated with this account is/i);
  });
});
