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

  it("locks SureShot Books virtual-assistant identity at the top of the prompt", () => {
    expect(SHOSHAN_SYSTEM_PROMPT.indexOf("YOUR IDENTITY")).toBeLessThan(
      SHOSHAN_SYSTEM_PROMPT.indexOf("SOVEREIGN STATE MACHINE"),
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/SOVEREIGN STATE MACHINE/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/SILENCE PROTOCOL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/SPATIAL TRACKING DICTATION/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/full summary/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Elite Customer Concierge and Virtual Assistant for SureShot Books/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Twilio has already spoken the opening greeting/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/STRICTLY BANNED identity phrases/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/never claim to BE the store/i);
    expect(SHOSHAN_SYSTEM_PROMPT).not.toMatch(/Shoshan/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/not a general AI assistant/i);
  });

  it("requires explicit goodbye before ending the call", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/EXPLICIT GOODBYE \/ HANGUP/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/OPEN-ENDED FLOW/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/I am sending the payment link to your email now/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Thank you for choosing SureShot Books/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/end_call/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CONVERSATIONAL WARMTH & TRANSITIONS/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Let me check on that in my system/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/search the catalog for you/i);
  });

  it("requires omni-channel support escalation with email verification", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/OMNI-CHANNEL ESCALATION S\.O\.P\./i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/jessica@sureshotbooks\.com/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /I have sent your request to the support team\. They will contact you shortly/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /securely verify you and reach out/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/backup warehouse/i);
  });

  it("requires extreme conciseness and direct-answer protocol", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/EXTREME CONCISENESS/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /The status is \[X\], you have \[Y\] items, and shipping is \[Z\]/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/repeat ONLY shipping/i);
  });

  it("requires strict unverified caller denial naming the verified customer", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /I am sorry, but for security reasons, I can only share that information with the verified account holder/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NO HALF-ANSWERS/i);
  });

  it("requires dynamic cart math and hangup prevention during shopping", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/DYNAMIC CART MATH PROTOCOL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NEVER END THE CALL DURING CART MODIFICATIONS/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/GLOBAL ANTI-HANGUP DIRECTIVE/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Dad to boy/i);
  });

  it("requires ordinal mapping and missing-data graceful fallback", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/ORDINAL MAPPING/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/physical_items array/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/MISSING DATA GRACEFUL FALLBACK/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/my system doesn't show that specific detail/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/each physical_items\[\]\.price/i);
  });

  it("requires exact match search protocol and zero assumption quantity", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/EXACT MATCH SEARCH PROTOCOL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/I found exactly what you are looking for/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/ZERO ASSUMPTION QUANTITY/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/How many copies of \[Book Title\] would you like to add/i);
  });

  it("requires isolation rule, repeat-it pronoun rule, and spatial dictation protocols", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/THE ISOLATION RULE/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NO DATA VOMITING/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/THE "REPEAT IT" PRONOUN RULE/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/resolve the pronoun "it" ONLY to the very last specific entity/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/STRICTLY FORBIDDEN from interpreting "it" as the entire order/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/PERMISSION TO ACT/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/PRIMARY MANDATORY DUTY to call the appropriate tool/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CATALOG SEARCH — MANDATORY TOOL INVOCATION/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/search_shopify_book_by_title with the extracted English title/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Never summarize books, processing fees, shipping fees/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/HUMAN SPATIAL DICTATION/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/After the 9, it is/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/physical_items/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/processing_fees/i);
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
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/inmate numbers or facility details/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/payment_method/i);
  });

  it("authorizes unverified callers for payment method and refund reason", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/UNVERIFIED CALLER — PRIVACY SHIELD/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Payment Method/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/cancel_reason or refund_reason/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Visa ending in 1234/i);
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
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/TRACKING ID DICTATION PROTOCOL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/I currently do not have a valid tracking number for this order/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Do not spell out words like "Refund"/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/pen and notepad ready/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Did you get all of that/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Were you able to write that down/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/SLOW-READ GUARDRAIL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/GAG ORDER \(AFTER NOTEPAD READY ONLY\)/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/SLOWLY OVERRIDE/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/tracking_number_for_tts verbatim/i);
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
