import type { StructuredOrder } from "../types/order.js";
import { planInstantConfirmation, planOrderLookupResponse } from "../agents/responsePlanner.js";

const ORDER_NUMBER_RE = /^#?\d{4,10}(?:-[A-Za-z0-9]{1,6})?$/;

/** Normalize Shopify order name — supports numeric (#21698) and suffix (#21698-F1). */
export function normalizeOrderNumber(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, "").toUpperCase();
  const suffixMatch = trimmed.match(/^#?(\d{4,10})-([A-Z0-9]{1,6})$/);
  if (suffixMatch) {
    return `#${suffixMatch[1]}-${suffixMatch[2]}`;
  }

  const digits = trimmed.replace(/[^\d#]/g, "");
  if (digits.startsWith("#")) return digits;
  const onlyDigits = digits.replace(/\D/g, "");
  return onlyDigits ? `#${onlyDigits}` : "";
}

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

const WORD_TO_DIGIT: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

function parseSpokenDigits(text: string): string {
  const tokens = text
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);

  let out = "";
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      out += token;
      continue;
    }
    const digit = WORD_TO_DIGIT[token];
    if (digit !== undefined) out += digit;
  }
  return out;
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
