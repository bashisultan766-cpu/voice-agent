import { describe, expect, it } from "vitest";
import { SHOSHAN_SYSTEM_PROMPT } from "../src/prompts/systemPrompt.js";

describe("SHOSHAN_SYSTEM_PROMPT anti-hallucination", () => {
  it("forbids inventing order data when tool returns NOT_FOUND", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CRITICAL ANTI-HALLUCINATION RULE/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/"status": "NOT_FOUND"/);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /I checked for order number \[searched_number\], but I could not find a match/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NEVER invent, guess, or create fake customer names/i);
  });

  it("requires repeating order number when caller asks for verification", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/VERIFICATION PROTOCOL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /The order number I heard is \[Number\]\. Is that correct\?/,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Do not claim you are unable to provide it/i);
  });

  it("locks SureShot Bookstore identity at the top of the prompt", () => {
    expect(SHOSHAN_SYSTEM_PROMPT.indexOf("YOUR IDENTITY")).toBeLessThan(
      SHOSHAN_SYSTEM_PROMPT.indexOf("CRITICAL — NO CONVERSATIONAL FILLERS"),
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/official AI Assistant for SureShot Bookstore/i);
    expect(SHOSHAN_SYSTEM_PROMPT).not.toMatch(/Shoshan/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/not a general AI assistant/i);
  });

  it("requires explicit goodbye before ending the call", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NEVER END THE CALL PREMATURELY/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Is there anything else I can help you with today/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/end_call/i);
  });

  it("requires omni-channel support escalation with email verification", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/OMNI-CHANNEL ESCALATION S\.O\.P\./i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/jessica@sureshotbooks\.com/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /I have sent your request to the support team\. They will contact you shortly/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /I will forward your details to our support team so they can reach out to you directly and securely/i,
    );
  });

  it("requires volume alternative suggestions for title search", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/TITLE & VOLUME SEARCH S\.O\.P\./i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/similarMatches/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Volume 3 and Volume 4/i);
  });

  it("requires real-world chaos protocols for multilingual, phonetic, and rambling callers", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/MULTILINGUAL PROTOCOL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/silently translate their search query into English/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/PHONETIC STT PROTOCOL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/B as in Boy, A, S as in Sam, H/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/INTERRUPTION & RAMBLING PROTOCOL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/LAST stated intention/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/What is your Order Number/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/FUZZY SEARCH KEYWORD EXTRACTION/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Harry Potter please/i);
  });

  it("forbids asking for phone number and mandates silent isVerifiedCaller verification", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CRITICAL IDENTITY RULE/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/STRICTLY FORBIDDEN from asking the customer for their phone number/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Can I get your phone number to verify your account/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/isVerifiedCaller/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/ONLY need the Order Number/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/backend Twilio integration/i);
  });

  it("requires VIP order history month drill-down for verified callers", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/VIP ORDER HISTORY DRILL-DOWN S\.O\.P\./i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Which month would you like to hear about/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/monthYear/i);
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

  it("requires progressive disclosure for initial order lookup", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/MULTILINGUAL PROTOCOL|Match the caller's language/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/ORDER LOOKUP S\.O\.P\./i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/I found your order/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Do you need any more information about your order/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/ACTIVE ORDER CONTEXT/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/I don't have that specific detail on file|that specific detail is not on file/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/TRACKING ID PROTOCOL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/pen and a notepad ready/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/SLOW-READ GUARDRAIL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/DO NOT invent your own spacing, dashes, ellipses, or SSML/i);
    expect(SHOSHAN_SYSTEM_PROMPT).not.toMatch(/PROACTIVE ORDER DELIVERY/i);
  });

  it("enforces INTERNATIONAL PROTOCOL verification & guidance", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/INTERNATIONAL PROTOCOL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/ANTI-HALLUCINATION LOCK/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Verification Framework/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /I can confirm that the order for \[customer_name\] was successfully refunded/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/card ending in \[payment_method_last4\]/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /The refund notification was sent to \[refund_notification_email_for_tts\]/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NEVER mention internal staff names/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Darren Herrington/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/refund_notification_email_for_tts/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/check your inbox and spam folder/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /I checked the official system logs for this order, but that specific detail is not on file/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/LEGACY ORDER FALLBACK/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/securely archived by Shopify/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/customer_email_for_tts/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/order_placed_at/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /NEVER use customer_email as a substitute for refund_notification_email on recent orders/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /Never say the information is not on file if the JSON context contains these fields/i,
    );
  });
});
