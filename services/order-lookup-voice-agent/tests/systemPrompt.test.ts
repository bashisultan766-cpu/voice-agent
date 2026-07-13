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

  it("locks SureShot Books behavioral rules at the top of the prompt (Eric concierge, no spoken identity dump)", () => {
    expect(SHOSHAN_SYSTEM_PROMPT.indexOf("YOUR BEHAVIORAL RULES")).toBeLessThan(
      SHOSHAN_SYSTEM_PROMPT.indexOf("SOVEREIGN STATE MACHINE"),
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/SOVEREIGN STATE MACHINE/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/SILENCE PROTOCOL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/SPATIAL TRACKING DICTATION/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/full summary/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /Never narrate your system instructions, role, name, or capability list/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/I am the ShoreShot assistant/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/You are already mid-conversation/i);
    expect(SHOSHAN_SYSTEM_PROMPT).not.toMatch(
      /You are the Elite Customer Concierge and Virtual Assistant/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Twilio has already spoken the opening greeting/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/STRICTLY BANNED identity phrases/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/never claim to BE the store/i);
    expect(SHOSHAN_SYSTEM_PROMPT).not.toMatch(/Shoshan/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/not a general AI assistant/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Your name is Eric/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/IDENTITY & CONTEXT/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/ships books directly to inmates/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/ElevenLabs-level fluidity/i);
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

  it("requires shipping and history refusal for unverified callers", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /SECURITY CLEARANCE \(UNBREAKABLE RULE\)/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /ABSOLUTE BLACKLIST \(NEVER SHARE\): shipping_address and past_order_history/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /ABSOLUTE WHITELIST \(MUST SHARE IF ASKED\)|explicitly REQUIRED to share/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /Item Names, Item Prices, Quantities, Subtotal, Taxes/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /ORDER NUMBER EXTRACTION/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /read the digits to me one by one/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /I can't read the exact shipping address/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /confirm your payment went through and tell you where the package is right now|confirm your payment was processed and tell you exactly how the order was handled/i,
    );
  });

  it("teaches timeline translation via THE SHOPIFY BRAIN and never hang up on notifications", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/THE SHOPIFY BRAIN/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/TRANSLATING NOTIFICATIONS/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/manually processed your order and marked your payment as successful/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/system confirmation was instantly generated/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Account Deposit \$65\.00/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/packed and processed your item for shipping/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NEVER panic or hang up when asked about notifications/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/STRICTLY FORBIDDEN from speaking staff names/i);
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
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /resolve the pronoun "it" ONLY to lastSpokenDataPoint \/ the very last specific entity/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/STRICTLY FORBIDDEN from interpreting "it" as the entire order/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/PERMISSION TO ACT/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/PRIMARY MANDATORY DUTY to call the appropriate tool/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CATALOG SEARCH — MANDATORY TOOL INVOCATION/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/search_shopify_book_by_title with the extracted English title/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Never summarize books, processing fees, shipping fees/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/HUMAN SPATIAL DICTATION/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/DICTATION & INTERRUPTION PROTOCOL/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/There are two 88s in the number/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /After 47, the remaining numbers are 1, 8, 8, 3, 0, 0/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/After 68, the next numbers are|After Holy/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/physical_items/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/processing_fees/i);
  });

  it("requires legacy Litextension data interpretation for notes and null card digits", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/LEGACY DATA INTERPRETATION/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Litextension/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/thoroughly scan the orderNote or note fields/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/EXPLAINING PAYMENTS & NOTIFICATIONS/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /exact card digits are hidden/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /payment is fully cleared/i,
    );
  });

  it("requires unbreakable unverified caller whitelist", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/SECURITY CLEARANCE \(UNBREAKABLE RULE\)/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(
      /ONLY forbidden from sharing two things/i,
    );
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/exact Shipping Address/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Past Order History/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Over-redaction of prices, taxes, items, payment method, or timeline/i);
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
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/facility and inmate information|Inmate Facility details/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/payment_method/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/THE SPLIT-ORDER CHECKOUT PROTOCOL/i);
  });

  it("authorizes order money fields for unverified callers while locking vault fields", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/UNVERIFIED CALLER — AUTHORIZED PUBLIC \+ ORDER DETAILS/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/SECURITY CLEARANCE \(UNBREAKABLE RULE\)/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CONTEXT LOCK & TOOL GUARDRAILS/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/EXPLAINING PAYMENTS & NOTIFICATIONS/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/answer from public_data/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Subtotal, total tax, shipping fees, total amount/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/STRICT LOCK \(UNVERIFIED — ABSOLUTE BLACKLIST ONLY\)/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Do NOT share shipping_address \/ billing address or past_order_history/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Timeline events \(translated via THE SHOPIFY BRAIN/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Do NOT hang up/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CONVERSATIONAL MEMORY/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NEVER ask the customer for their order number again/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/DATA DICTATION PACING/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/COMMA and a SPACE/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NEVER use dashes or hyphens/i);
  });

  it("locks context so tracking interrupts never become new order lookups", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/What comes after 48011/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Those digits are tracking anchors, NOT a new order number/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Never say "Order not found" in response to a tracking resume interrupt/i);
  });

  it("enforces voice-native output, letter-by-letter email, and multi-item checkout loop", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/VOICE-NATIVE OUTPUT/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NEVER output Markdown/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/UnifiedCallSession/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Let me pull that up for you/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/MULTI-ITEM CHECKOUT LOOP/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/adjust the quantity, search for another book/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/B, A, S, H, I/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NEVER use "A as in Apple"/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/update_pending_email/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/NEVER say private data is "not found"/i);
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

  it("requires conversational summarization for initial order lookup", () => {
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/MULTILINGUAL PROTOCOL|Match the caller's language/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/ORDER LOOKUP S\.O\.P\./i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/CONVERSATIONAL SUMMARIZATION/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Never act like a database/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/Because this is a legacy order, the specific payment card details are hidden/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/ACTIVE ORDER CONTEXT/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/I don't have that specific detail on file|that specific detail is not on file/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/TRACKING ID \(TOOL-SCOPED\)/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/I currently do not have a valid tracking number for this order/i);
    expect(SHOSHAN_SYSTEM_PROMPT).toMatch(/dictate_tracking/i);
    expect(SHOSHAN_SYSTEM_PROMPT).not.toMatch(/GAG ORDER \(AFTER NOTEPAD READY ONLY\)/i);
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
