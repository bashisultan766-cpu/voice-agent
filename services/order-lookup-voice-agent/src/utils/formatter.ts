import type { StructuredOrder } from "../types/order.js";
import { planInstantConfirmation, planOrderLookupResponse } from "../agents/responsePlanner.js";

import { normalizeOrderNumber } from "./inputNormalizer.js";

export { normalizeOrderNumber };

const ORDER_NUMBER_RE = /^#?\d{4,10}(?:-[A-Za-z0-9]{1,6})?$/;

export function isValidOrderNumberFormat(orderNumber: string): boolean {
  return ORDER_NUMBER_RE.test(orderNumber);
}

/** True when Shopify order name matches caller-provided number (exact or base+dash suffix). */
export function orderNumbersMatch(shopifyName: string, normalized: string): boolean {
  const shop = shopifyName.replace(/^#/, "").toUpperCase();
  const query = normalized.replace(/^#/, "").toUpperCase();
  if (!shop || !query) return false;
  return shop === query || shop.startsWith(`${query}-`);
}

export function extractOrderNumberFromSpeech(text: string): string | null {
  const spoken = text.toLowerCase();

  const hashMatch = spoken.match(
    /(?:order\s*(?:number|#)?|number)\s*#?\s*(\d{4,10}(?:-[a-z0-9]{1,6})?)/i,
  );
  if (hashMatch?.[1]) return normalizeOrderNumber(hashMatch[1]);

  const digitRun = spoken.match(/\b(\d{4,10})\b/);
  if (digitRun?.[1]) return `#${digitRun[1]}`;

  const wordDigits = parseSpokenDigits(spoken);
  if (wordDigits.length >= 4 && wordDigits.length <= 10) {
    return `#${wordDigits}`;
  }

  return null;
}

function parseSpokenDigits(text: string): string {
  return normalizeOrderNumber(text).replace(/^#/, "").replace(/-.*$/, "");
}

export function speakCardLast4(last4: string): string {
  const digits = last4.replace(/\D/g, "").slice(-4);
  if (!digits) return "";
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  return digits
    .split("")
    .map((d) => words[Number(d)] ?? d)
    .join(", ");
}

const TRACKING_DIGIT_WORD: Record<string, string> = {
  "0": "zero",
  "1": "one",
  "2": "two",
  "3": "three",
  "4": "four",
  "5": "five",
  "6": "six",
  "7": "seven",
  "8": "eight",
  "9": "nine",
};

/** Literal digit sequence for tracking chunks — never raw "02" (avoids decimal TTS). */
export function formatTrackingDigitSequenceForSpeech(sequence: string): string {
  const digits = [...sequence.replace(/\D/g, "")];
  if (!digits.length) return "";
  return digits.map((d) => TRACKING_DIGIT_WORD[d] ?? d).join(", ");
}

/** Optional SSML character interpretation for relays that support say-as. */
export function wrapTrackingChunkSsml(sequence: string): string {
  const digits = sequence.replace(/\D/g, "");
  if (!digits) return "";
  return `<say-as interpret-as="characters">${digits}</say-as>`;
}

export function speakMoney(amount: string): string {
  const cleaned = amount.trim();
  if (!cleaned) return "an unknown amount";
  const match = cleaned.match(/([\d,.]+)\s*([A-Z]{3})?/);
  if (!match) return cleaned;
  const numeric = Number(match[1].replace(/,/g, ""));
  const currency = match[2] ?? "USD";
  if (!Number.isFinite(numeric)) return cleaned;

  const dollars = Math.floor(numeric);
  const cents = Math.round((numeric - dollars) * 100);
  const unit = currency === "USD" ? "dollars" : currency;
  if (cents > 0) {
    return `${dollars} ${unit} and ${cents} cents`;
  }
  return `${dollars} ${unit}`;
}

export function speakProductList(products: StructuredOrder["products"]): string {
  const items = products.filter((p) => p.name && !/processing fee/i.test(p.name));
  if (!items.length) return "";

  const parts = items.map((item) => {
    if (item.quantity > 1) {
      return `${item.quantity} copies of ${item.name}`;
    }
    return item.name;
  });

  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

export function fulfillmentStatusPhrase(status: string): string {
  const normalized = status.trim().toLowerCase().replace(/_/g, " ");
  if (!normalized || normalized === "unfulfilled") return "awaiting fulfillment";
  return normalized;
}

export function buildOrderVoiceScript(order: StructuredOrder): string {
  const confirmation = planInstantConfirmation(order);
  const detail = planOrderLookupResponse(order);
  return [confirmation.text, ...detail.chunks.map((c) => c.text)].join(" ");
}

export const GREETING_PROMPT =
  "Please provide your order number.";

export const INVALID_ORDER_RETRY =
  "I didn't catch a valid order number. Please say your order number — it's usually four to six digits.";

export { ORDER_NOT_FOUND_MESSAGE } from "../constants/systemMessages.js";

export const SHOPIFY_DOWN_MESSAGE =
  "I'm having trouble reaching our order system right now. Please try again in a few minutes, or contact support online.";

export const GOODBYE_MESSAGE =
  "Thank you for calling SureShot Books. Have a great day.";

export const FOLLOW_UP_PROMPT =
  "I'm happy to help with anything else about this order. What would you like to know?";
