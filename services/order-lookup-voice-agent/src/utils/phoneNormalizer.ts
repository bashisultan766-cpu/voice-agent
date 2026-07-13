/**
 * Normalize phone numbers for cryptographic caller-ID verification.
 * Strips formatting and leading country codes so equivalent numbers match.
 */
const BLOCKED_CALLER_LABELS = new Set([
  "anonymous",
  "restricted",
  "unknown",
  "unavailable",
  "private",
  "withheld",
]);

export function normalizePhoneNumber(raw: string | undefined | null): string {
  if (raw === undefined || raw === null) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  if (BLOCKED_CALLER_LABELS.has(trimmed.toLowerCase())) return "";

  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  // US/CA +1
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  // International 00-prefix dialing
  if (digits.startsWith("00") && digits.length > 11) {
    digits = digits.slice(2);
  }
  return digits;
}

/** True when both numbers normalize to the same non-empty digit string. */
export function phoneNumbersMatch(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  const left = normalizePhoneNumber(a);
  const right = normalizePhoneNumber(b);
  if (!left || !right) return false;
  if (left === right) return true;
  // Match national numbers across country-code prefixes (last 10 digits).
  if (left.length >= 10 && right.length >= 10) {
    return left.slice(-10) === right.slice(-10);
  }
  return false;
}

/** True when caller phone matches any normalized Shopify verification phone. */
export function callerMatchesAnyShopifyPhone(
  callerPhone: string | undefined | null,
  shopifyPhones: Array<string | undefined | null>,
): boolean {
  const caller = normalizePhoneNumber(callerPhone);
  if (!caller) return false;
  return shopifyPhones.some((phone) => phoneNumbersMatch(callerPhone, phone));
}
