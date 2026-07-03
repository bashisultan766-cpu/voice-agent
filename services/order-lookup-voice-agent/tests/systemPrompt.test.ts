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

  it("locks Shoshan identity at the top of the prompt", () => {
    expect(SHOSHAN_SYSTEM_PROMPT.indexOf("YOUR IDENTITY")).toBeLessThan(
      SHOSHAN_SYSTEM_PROMPT.indexOf("CRITICAL — NO CONVERSATIONAL FILLERS"),
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/official AI Assistant for "Shoshan"/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/not a general AI assistant/i);
  });

  it("requires dynamic topic Polite Pivot instruction", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/MUST dynamically use the user's specific requested topic/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/DO NOT literally repeat the "football" example/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/how to watch cricket/i);
  });

  it("requires Polite Pivot for out-of-domain questions", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CRITICAL RULE — OUT OF DOMAIN/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Polite Pivot/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/football streaming/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/don't have access to recipes/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/strictly forbidden from answering general knowledge/i);
  });

  it("requires fluent English and customer_email in proactive template", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/fluent, professional English/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/customer_email/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/PROACTIVE ORDER DELIVERY/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/The email associated with this account is/i);
  });
});
